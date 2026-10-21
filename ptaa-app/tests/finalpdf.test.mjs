import test from "node:test";
import assert from "node:assert/strict";

test("the invoice goes just before Appendix B, else after Appendix A", async (t) => {
  let invoiceInsertIndex;
  try { ({ invoiceInsertIndex } = await import("../js/finalpdf.js")); }
  catch { t.skip("needs a browser"); return; }
  assert.equal(invoiceInsertIndex(["a", "APPENDIX A Renovation Cost Details / Invoice", "APPENDIX B"]), 2);
  assert.equal(invoiceInsertIndex(["a", "APPENDIX A Renovation Cost Details", "quote p1", "quote p2", "APPENDIX B"]), 4);
  assert.equal(invoiceInsertIndex(["a", "APPENDIX​ A Renovation Cost Details / Invoice"]), 2);
  assert.equal(invoiceInsertIndex(["a", "b"]), 2);
  // a clause that only mentions Appendix B is not the Appendix B page
  assert.equal(invoiceInsertIndex(["see Appendix B for partition works", "APPENDIX A x", "APPENDIX B y"]), 2);
});
