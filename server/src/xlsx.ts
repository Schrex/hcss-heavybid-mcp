import { zipSync, strToU8 } from "fflate";
import { COLUMNS } from "./breakdown.js";

// Minimal hand-written .xlsx (inline strings, no styles), zipped with no compression (level 0)
// to keep CPU time low on the Workers free plan (10 ms CPU/request).
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const colName = (i: number) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

function cell(v: unknown, ref: string): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}
function sheet(rows: unknown[][], freezeHeader: boolean): string {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, colName(ci) + (ri + 1))).join("")}</row>`).join("");
  const views = freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  const filter = freezeHeader && rows.length ? `<autoFilter ref="A1:${colName(rows[0].length - 1)}${rows.length}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}<sheetData>${body}</sheetData>${filter}</worksheet>`;
}

export function toXlsx(rows: Record<string, unknown>[], title: string): Uint8Array {
  const main = [COLUMNS.map((c) => c.header), ...rows.map((r) => COLUMNS.map((c) => r[c.key]))];
  const notes = [["Estimate", title], ["Generated", new Date().toISOString()], [], ["Column", "HCSS source"], ...COLUMNS.map((c) => [c.header, c.source])];
  const ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets><sheet name="Cost Breakdown" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Cost Breakdown'!$A$1:$${colName(COLUMNS.length - 1)}$${main.length}</definedName></definedNames></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet(main, true)),
    "xl/worksheets/sheet2.xml": strToU8(sheet(notes, false)),
  };
  return zipSync(files, { level: 0 });
}
