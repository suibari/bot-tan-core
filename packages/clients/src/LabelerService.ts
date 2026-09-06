import axios from "axios";
import dotenv from "dotenv";
import { loopbackUrlFromPort } from "@bsky-affirmative-bot/shared-configs";

dotenv.config();

const getLabelerPublicUrl = () => process.env.LABELER_PUBLIC_URL || process.env.LABELER_SERVER_URL || "http://127.0.0.1:3400";
export const getLabelerInternalUrl = () => loopbackUrlFromPort("LABELER_INTERNAL_PORT", 3401);
export const botLabelerManager = {
  /**
   * Upsert a label definition dynamically by calling the internal API (port 3401).
   * @param identifier The label's identifier (e.g. super-positive-lv.1, title-did-plc-...)
   * @param locales Localization strings containing ja/en name and description
   */
  upsertLabelDefinition: async (
    identifier: string,
    locales: Array<{ lang: string; name: string; description: string }>
  ) => {
    const url = `${getLabelerInternalUrl()}/upsert-definition`;
    try {
      const res = await axios.post(
        url,
        { identifier, locales }
      );
      return res.data;
    } catch (e: any) {
      console.error(`[ERROR] Failed to upsert label definition ${identifier}:`, e.response?.data || e.message);
      throw e;
    }
  },
  /**
   * Apply (create or negate) a label for a given DID using the internal loopback API (port 3401).
   * @param did The subject's DID (e.g. did:plc:...)
   * @param val The label value (e.g. bot-tan-sub, super-positive-l1)
   * @param negate Whether to remove/negate this label
   */
  applyLabel: async (did: string, val: string, negate = false, exp?: string) => {
    const url = `${getLabelerInternalUrl()}/label`;

    try {
      const res = await axios.post(
        url,
        { did, val, negate, exp }
      );
      return res.data;
    } catch (e: any) {
      console.error(`[ERROR] Failed to apply label ${val} to ${did}:`, e.response?.data || e.message);
      throw e;
    }
  },
  /**
   * Get currently active DIDs for a specific label value from the internal API (port 3401).
   * @param val The label value (e.g. bot-tan-sub)
   */
  getActiveLabels: async (val: string): Promise<string[]> => {
    const url = `${getLabelerInternalUrl()}/active-dids`;

    try {
      const res = await axios.get(url, {
        params: { val }
      });
      return res.data.dids || [];
    } catch (e: any) {
      console.error(`[ERROR] Failed to query active labels for ${val} via internal API:`, e.response?.data || e.message);
      return [];
    }
  }
};
