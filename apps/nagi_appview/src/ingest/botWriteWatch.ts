import { config } from "../config.js";
import { JetstreamLagWatch } from "./jetstreamLag.js";

/** internal API と Jetstream 受信の両方から触る、プロセスで1つの目印。 */
export const botWriteWatch = new JetstreamLagWatch({
  botDid: config.botDid,
  stallAfterMs: config.jetstreamStallSeconds * 1_000,
  // 全候補へ一巡しても届かない目印は、上流ではなく目印側の問題として諦める。
  maxStrikes: Math.max(2, config.jetstreamUrls.length),
});
