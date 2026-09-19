/* 開発補助: 総評生成にかかる時間を測る。引数は提出 URI。 */
import { runNagiZenkatsu } from "../src/NagiZenkatsuFeature.js";
const uri = process.argv[2];
const started = Date.now();
await runNagiZenkatsu(uri);
console.log(`[time] runNagiZenkatsu: ${Date.now() - started}ms`);
process.exit(0);
