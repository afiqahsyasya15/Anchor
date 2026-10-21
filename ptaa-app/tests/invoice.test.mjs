// Invoice numbering, and filling the office's Excel invoice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  nextInvoiceNo, parseInvoiceNo, invoiceFilename, fillInvoiceSheet, excelSerial,
  inlineSharedMarkers, printWithoutGridlines, sharedStringTexts,
} from "../js/invoice.js";
import { planAgentImport, parseCsv, driveFolderIdFrom } from "../js/lists.js";

test("invoice numbers carry on from the last one used", () => {
  const sep = new Date(2026, 8, 24), oct = new Date(2026, 9, 2);
  assert.equal(nextInvoiceNo("BLKINV-2609033", { now: sep }), "BLKINV-2609034");
  assert.equal(nextInvoiceNo("BLKINV-2609033", { now: oct }), "BLKINV-2610034");
  assert.equal(nextInvoiceNo("BLKINV-2609033", { now: oct, resetMonthly: true }), "BLKINV-2610001");
  assert.equal(nextInvoiceNo("", { now: sep }), "BLKINV-2609001");
  assert.deepEqual(parseInvoiceNo("blkinv-2609033"), { prefix: "BLKINV-", yymm: "2609", seq: 33 });
  assert.equal(parseInvoiceNo("INV 12"), null);
});

test("invoice filename matches the office's", () => {
  assert.equal(invoiceFilename({ propertyName: "SUNWAY JERNIH", unitNo: "B-38-12" }),
               "SUNWAY JERNIH B-38-12 INVOICE.xlsx");
});

test("the sheet grows to fit the items and the totals move down with it", (t) => {
  let xml;
  try {
    const path = new URL("../assets/invoice-template.xlsx", import.meta.url).pathname;
    xml = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"]).toString();
    // Saved from Excel: the markers live in the shared strings.
    xml = inlineSharedMarkers(xml, execFileSync("unzip", ["-p", path, "xl/sharedStrings.xml"]).toString());
  } catch { t.skip("unzip not available"); return; }
  const items = Array.from({ length: 10 }, (_, i) => ({ description: `Item ${i + 1}\ndetail`, qty: i === 9 ? "FOC" : 1 }));
  const out = fillInvoiceSheet(xml, { billTo: "A & B\nCONDO X-1", invoiceNo: "BLKINV-2609034",
    date: new Date(2026, 8, 24), items, total: 1000, pay1: 100, pay2: 0, pay3: 0 });
  assert.match(out, /<c r="A21" s="\d+"><v>10<\/v><\/c>/);                 // tenth item on row 21
  assert.match(out, /<mergeCell ref="G12:H21"\/>/);                        // one Amount box
  assert.match(out, /<f>G23-G24-G25-G26<\/f><v>900<\/v>/);                 // balance, shifted by 7
  assert.match(out, /A &amp; B\nCONDO X-1/);
  assert.match(out, new RegExp(`<c r="H7" s="\\d+"><v>${excelSerial(new Date(2026, 8, 24))}</v>`));
  assert.ok(!/\{\{/.test(out), "no marker left behind");
});

function templateSheet() {
  const path = new URL("../assets/invoice-template.xlsx", import.meta.url).pathname;
  return inlineSharedMarkers(execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"]).toString(),
                             execFileSync("unzip", ["-p", path, "xl/sharedStrings.xml"]).toString());
}
const BASE = { billTo: "X", invoiceNo: "BLKINV-2610001", date: new Date(2026, 9, 7),
  items: [{ description: "A", qty: 1 }, { description: "B", qty: 1 }, { description: "C", qty: 1 }] };

test("a 4th payment adds its own row, and the balance takes it off too", () => {
  const out = fillInvoiceSheet(templateSheet(), { ...BASE, total: 10000, pay1: 1000, pay2: 2000, pay3: 3000, pay4: 4000 });
  assert.match(out, /<c r="E20"[^>]*t="inlineStr"><is><t xml:space="preserve">4th Payment<\/t><\/is><\/c>/);
  assert.match(out, /<c r="G20" s="\d+"><v>4000<\/v><\/c>/);
  assert.match(out, /<f>G16-G17-G18-G19-G20<\/f><v>0<\/v>/);           // balance moved to row 21
  assert.match(out, /<mergeCell ref="E20:F20"\/>/);
  assert.match(out, /<mergeCell ref="E21:F21"\/>/);                      // the balance label, moved
  assert.match(out, /<c r="A36" s="\d+"><v>9<\/v><\/c>/);               // the terms moved down one row
});

test("no 4th payment: the sheet is as before", () => {
  const out = fillInvoiceSheet(templateSheet(), { ...BASE, total: 10000, pay1: 1000, pay2: 0, pay3: 0 });
  assert.ok(!/4th Payment/.test(out));
  assert.match(out, /<f>G16-G17-G18-G19<\/f><v>9000<\/v>/);
  assert.match(out, /<c r="A34" s="\d+"><v>8<\/v><\/c>/);
  assert.match(out, /<c r="A35" s="\d+"><v>9<\/v><\/c>/);
});

test("paid in full: term 8 (Blank Finance fee) goes and term 9 becomes 8", () => {
  const out = fillInvoiceSheet(templateSheet(), { ...BASE, total: 10000, pay1: 10000, pay2: 0, pay3: 0, fullPayment: true });
  assert.ok(!/<row r="35"/.test(out), "one row fewer");
  assert.match(out, /<c r="A34" s="\d+"><v>8<\/v><\/c>/);
  assert.match(out, /<c r="B34" s="\d+" t="s"><v>24<\/v><\/c>/, "row 34 now holds what was term 9");
  assert.ok(!/<v>23<\/v>/.test(out.slice(out.indexOf('<row r="23"'))), "the Blank Finance fee text is gone");
  assert.match(out, /<dimension ref="A1:H34"\/>/);
});

test("markers Excel moved into the shared strings are put back in their cells", () => {
  const sst = '<sst><si><t>Description</t></si><si><r><t>BLANKCO </t></r><r><t>HOLDINGS</t></r></si><si><t>{{BILL_TO}}</t></si></sst>';
  assert.deepEqual(sharedStringTexts(sst), ["Description", "BLANKCO HOLDINGS", "{{BILL_TO}}"]);
  const sheet = '<row r="7"><c r="A7" s="82" t="s"><v>2</v></c><c r="B7" s="3" t="s"><v>0</v></c></row>';
  const out = inlineSharedMarkers(sheet, sst);
  assert.match(out, /<c r="A7" s="82" t="inlineStr"><is><t xml:space="preserve">\{\{BILL_TO\}\}<\/t><\/is><\/c>/);
  assert.match(out, /<c r="B7" s="3" t="s"><v>0<\/v><\/c>/, "ordinary text is left alone");
});

test("the invoice prints without gridlines or notes", () => {
  const xml = '<worksheet><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
    '<printOptions horizontalCentered="1" gridLines="1"/><pageSetup paperSize="9" cellComments="atEnd"/></worksheet>';
  const out = printWithoutGridlines(xml);
  assert.match(out, /<sheetView showGridLines="0" tabSelected="1"/);
  assert.match(out, /<printOptions horizontalCentered="1"\/>/);
  assert.match(out, /<pageSetup paperSize="9"\/>/);
});

test("agent import skips repeats in the file and people already listed", () => {
  const plan = planAgentImport([
    { fullName: "Tan Jian Yong", nickname: "Jeff", nric: "880511-07-5257", phone: "012-518 6772" },
    { fullName: "Tan Jian Yong", nickname: "Jeff Tan", nric: "880511075257", phone: "012-518 6772" },
    { fullName: "", nickname: "YM", nric: "", phone: "60122907649" },
    { fullName: "???", nickname: "Jenson", nric: "???", phone: "" },
  ], [{ fullName: "", nickname: "YM", nric: "", phone: "012-290 7649" }]);
  assert.equal(plan.toAdd.length, 2);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.already.length, 1);
  assert.deepEqual(plan.toAdd[1].problems, ["full name missing", "I/C missing", "phone missing"]);
});

test("CSV and Drive links", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.equal(driveFolderIdFrom("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=sharing"), "1AbCdEfGhIjKlMn");
  assert.equal(driveFolderIdFrom("not a link"), "");
});

test("month folder names follow the office's pattern", async () => {
  const { monthFolderName } = await import("../js/lists.js");
  assert.equal(monthFolderName("MMM YY INV", new Date(2026, 8, 24)), "SEP 26 INV");
  assert.equal(monthFolderName("MMM YY INV", new Date(2026, 9, 1)), "OCT 26 INV");
  assert.equal(monthFolderName("MMM-YY", new Date(2027, 0, 5)), "JAN-27");
});
