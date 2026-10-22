/** Print aggregate metrics only; never print source posts or generated diary prose. */
import { readFile } from "node:fs/promises";

const reports = await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
if (!reports.length) throw new Error("Pass evaluation result JSON files");
for (const report of reports) {
  if (report.results.length !== report.requestsPlanned) throw new Error("Evaluation is incomplete");
  const pairs = new Map();
  for (const row of report.results) {
    const key = `${row.case}:${row.repetition}`;
    const formats = pairs.get(key) ?? new Set();
    if (formats.has(row.format)) throw new Error("Duplicate evaluation result");
    formats.add(row.format);
    pairs.set(key, formats);
  }
  if ([...pairs.values()].some((formats) => formats.size !== 2 || !formats.has("excerpt") || !formats.has("paragraphFlags"))) throw new Error("Unpaired evaluation result");
}
const rows = reports.flatMap((report) => report.results);
const mean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summarize = (items) => {
  const reasons = {};
  for (const item of items) if (item.reason) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  const usages = items.flatMap((item) => item.usages);
  return {
    trials: items.length, success: items.filter((item) => item.success).length,
    failures: items.filter((item) => !item.success).length, reasons,
    calls: items.reduce((n, item) => n + item.calls, 0),
    inputTokens: usages.reduce((n, u) => n + u.promptTokens, 0),
    outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
    meanOutputTokens: mean(usages.map((u) => u.outputTokens)),
    truncated: usages.filter((u) => u.truncated).length,
    meanLatencyMs: mean(items.map((item) => item.elapsedMs)),
    medianLatencyMs: median(items.map((item) => item.elapsedMs)),
    jsonOver2100: items.filter((item) => item.raw.length > 2100).length,
  };
};
const formats = {};
for (const format of ["excerpt", "paragraphFlags"]) {
  const items = rows.filter((row) => row.format === format);
  formats[format] = {
    ...summarize(items),
    groups: Object.fromEntries([...new Set(items.map((item) => item.group))].map((group) => [group, summarize(items.filter((item) => item.group === group))])),
  };
}
console.log(JSON.stringify({
  requestsCompleted: rows.length,
  inputSha256: reports.map((report) => report.inputSha256),
  formats,
}, null, 2));
