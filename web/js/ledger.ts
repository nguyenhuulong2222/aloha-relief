/**
 * Public ledger with AG Grid Community 36.2 (MIT). https://www.ag-grid.com/javascript-data-grid/
 * Community features only: client-side row model, text/number/date filters, quick filter, external
 * filter, pinned totals row (pinnedBottomRowData), CSV export (api.exportDataAsCsv), row styles.
 */
import {
  type CellClassParams,
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  type ColDef,
  CsvExportModule,
  createGrid,
  DateFilterModule,
  ExternalFilterModule,
  type GridApi,
  type IRowNode,
  ModuleRegistry,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RowApiModule,
  RowStyleModule,
  ScrollApiModule,
  TextFilterModule,
  themeQuartz,
  type ValueFormatterParams,
} from "ag-grid-community";
import { api, money, renderFund } from "./common.js";

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  ClientSideRowModelApiModule, // forEachNodeAfterFilter
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  QuickFilterModule,
  ExternalFilterModule,
  PinnedRowModule,
  CsvExportModule,
  RowStyleModule,
  CellStyleModule,
  RowApiModule,
  ScrollApiModule,
]);

interface Row {
  public_ref: string;
  kind: "donation" | "grant";
  need_type: string | null;
  island: string | null;
  amount_cents: number;
  status: string;
  at: string;
  source: "sandbox" | "seeded";
}

const ISLAND: Record<string, string> = {
  maui: "Maui",
  molokai: "Molokaʻi",
  lanai: "Lānaʻi",
  hawaii: "Hawaiʻi Island",
  oahu: "Oʻahu",
  kauai: "Kauaʻi",
};
const STATUS: Record<string, [label: string, group: "done" | "moving" | "problem"]> = {
  captured: ["Received", "done"],
  pending: ["On the way", "moving"],
  refunded: ["Refunded", "problem"],
  succeeded: ["Paid", "done"],
  unclaimed: ["Sent, unclaimed", "moving"],
  creating: ["On the way", "moving"],
  processing: ["On the way", "moving"],
  held: ["Held by PayPal", "moving"],
  failed: ["Failed", "problem"],
  returned: ["Returned", "problem"],
  blocked: ["Blocked by PayPal", "problem"],
  canceled: ["Canceled", "problem"],
  denied: ["Denied", "problem"],
};
const cap = (s: string | null) => (s ? s[0]!.toUpperCase() + s.slice(1) : "");

let kind = "";
let island = "";
let statusGroup = "";
const seen = new Set<string>();
const newRefs = new Set<string>();
let lastTotals = "";
let firstLoad = true;
const target = decodeURIComponent(location.hash.slice(1));

const columnDefs: ColDef<Row>[] = [
  { field: "public_ref", headerName: "Ref", width: 110, filter: "agTextColumnFilter" },
  {
    field: "at",
    headerName: "Date",
    width: 170,
    sort: "desc",
    filter: "agDateColumnFilter",
    valueGetter: (p) => (p.data?.at ? new Date(p.data.at) : null),
    valueFormatter: (p: ValueFormatterParams<Row, Date | null>) =>
      p.value
        ? p.value.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "",
    filterParams: {
      comparator: (filterDate: Date, cell: Date | null) => {
        if (!cell) return -1;
        const d = new Date(cell.getFullYear(), cell.getMonth(), cell.getDate()).getTime();
        return d === filterDate.getTime() ? 0 : d < filterDate.getTime() ? -1 : 1;
      },
    },
  },
  {
    field: "kind",
    headerName: "Type",
    width: 120,
    valueFormatter: (p) =>
      p.value === "donation" ? "Donation" : p.value === "grant" ? "Grant" : (p.value ?? ""),
    filter: "agTextColumnFilter",
  },
  {
    field: "need_type",
    headerName: "Need",
    width: 120,
    valueFormatter: (p) => cap(p.value),
    filter: "agTextColumnFilter",
  },
  {
    field: "island",
    headerName: "Island",
    width: 150,
    valueFormatter: (p) => (p.value ? (ISLAND[p.value] ?? p.value) : ""),
    filter: "agTextColumnFilter",
  },
  {
    field: "amount_cents",
    headerName: "Amount",
    width: 130,
    type: "rightAligned",
    filter: "agNumberColumnFilter",
    valueFormatter: (p) => (typeof p.value === "number" ? money(p.value) : ""),
    cellClassRules: {
      "amt-in": (p: CellClassParams<Row>) => p.data?.kind === "donation",
      "amt-out": (p: CellClassParams<Row>) => p.data?.kind === "grant",
    },
  },
  {
    field: "status",
    headerName: "Status",
    flex: 1,
    minWidth: 170,
    valueFormatter: (p) => STATUS[p.value as string]?.[0] ?? p.value ?? "",
    filter: "agTextColumnFilter",
    cellClassRules: {
      "st-done": (p) => STATUS[p.value as string]?.[1] === "done",
      "st-moving": (p) => STATUS[p.value as string]?.[1] === "moving",
      "st-problem": (p) => STATUS[p.value as string]?.[1] === "problem",
    },
  },
  {
    field: "source",
    headerName: "Source",
    width: 120,
    valueFormatter: (p) => cap(p.value),
    filter: "agTextColumnFilter",
  },
];

const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 15,
  headerFontWeight: 700,
  foregroundColor: "#1d2a2f",
  headerBackgroundColor: "#e3eff2",
  borderColor: "#d5dcda",
  rowHoverColor: "#f3f5f4",
  accentColor: "#0b5d73",
  pinnedRowBackgroundColor: "#e3eff2",
});

const grid: GridApi<Row> = createGrid(document.getElementById("grid")!, {
  theme,
  columnDefs,
  rowData: [],
  defaultColDef: { sortable: true, resizable: true, floatingFilter: false },
  getRowId: (p) => p.data.public_ref,
  rowClassRules: {
    "is-new": (p) => !p.node.rowPinned && !!p.data && newRefs.has(p.data.public_ref),
    "is-target": (p) => !!p.data && p.data.public_ref === target,
  },
  isExternalFilterPresent: () => kind !== "" || island !== "" || statusGroup !== "",
  doesExternalFilterPass: (node: IRowNode<Row>) => {
    const d = node.data;
    if (!d) return false;
    if (kind && d.kind !== kind) return false;
    if (island && d.island !== island) return false;
    if (statusGroup && STATUS[d.status]?.[1] !== statusGroup) return false;
    return true;
  },
  // Totals follow whatever is currently shown, after filters and search.
  onModelUpdated: () => updateTotals(),
  overlayNoRowsTemplate: "<span>No entries match these filters.</span>",
});

function updateTotals() {
  let inCents = 0;
  let outCents = 0;
  let count = 0;
  grid.forEachNodeAfterFilter((n) => {
    if (!n.data) return;
    count++;
    const group = STATUS[n.data.status]?.[1];
    if (n.data.kind === "donation" && group === "done") inCents += n.data.amount_cents;
    if (n.data.kind === "grant" && group !== "problem") outCents += n.data.amount_cents;
  });
  const key = `${count}|${inCents}|${outCents}`;
  if (key === lastTotals) return; // setting pinned rows must not loop back through onModelUpdated
  lastTotals = key;
  grid.setGridOption("pinnedBottomRowData", [
    {
      public_ref: "Net shown",
      kind: "" as Row["kind"],
      need_type: null,
      island: null,
      amount_cents: inCents - outCents,
      status: "",
      at: "",
      source: "" as Row["source"],
    } as Row,
  ]);
  document.getElementById("row-count")!.textContent =
    `${count} ${count === 1 ? "entry" : "entries"} shown. In: ${money(inCents)}. Granted or on the way: ${money(outCents)}. Net: ${money(inCents - outCents)}.`;
}

async function load() {
  const res = await api<{ rows: Row[] }>("/api/ledger");
  if (!res.ok) return;
  newRefs.clear();
  for (const r of res.data.rows) {
    if (!firstLoad && !seen.has(r.public_ref)) newRefs.add(r.public_ref);
    seen.add(r.public_ref);
  }
  grid.setGridOption("rowData", res.data.rows);
  if (firstLoad && target) {
    const node = grid.getRowNode(target);
    if (node) grid.ensureNodeVisible(node, "middle");
  }
  firstLoad = false;
}

async function loadHealth() {
  const f = await renderFund();
  if (!f) return;
  const set = (id: string, v: string) => {
    document.getElementById(id)!.textContent = v;
  };
  set("s-in", money(f.inCents));
  set("s-out", money(f.outCents));
  set("s-pending", money(f.pendingCents));
  set("s-avail", money(Math.max(0, f.availableCents)));
  set("s-grants", String(f.grantsPaid));
  set("s-waiting", String(f.requestsWaiting));
  set("s-time", f.avgHoursToGrant === null ? "–" : `${f.avgHoursToGrant} h`);
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
  b.addEventListener("click", () => {
    kind = b.dataset.kind ?? "";
    for (const x of document.querySelectorAll(".seg button"))
      x.setAttribute("aria-pressed", String(x === b));
    grid.onFilterChanged();
  });
}
document.getElementById("f-island")!.addEventListener("change", (e) => {
  island = (e.target as HTMLSelectElement).value;
  grid.onFilterChanged();
});
document.getElementById("f-status")!.addEventListener("change", (e) => {
  statusGroup = (e.target as HTMLSelectElement).value;
  grid.onFilterChanged();
});
document.getElementById("f-search")!.addEventListener("input", (e) => {
  grid.setGridOption("quickFilterText", (e.target as HTMLInputElement).value);
});
document.getElementById("export")!.addEventListener("click", () => {
  grid.exportDataAsCsv({
    fileName: `kanaloa-relief-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
    skipPinnedBottom: true,
    processCellCallback: (p) => {
      const col = p.column.getColId();
      if (col === "amount_cents") return ((p.value as number) / 100).toFixed(2);
      if (col === "at") return p.value instanceof Date ? p.value.toISOString() : "";
      if (col === "status") return STATUS[p.value as string]?.[0] ?? p.value;
      return p.value ?? "";
    },
  });
});

void load();
void loadHealth();
setInterval(() => {
  void load();
  void loadHealth();
}, 10_000);
