import { db, nagiDrafts } from "@bsky-affirmative-bot/database";
import type {
  DraftContent,
  DraftSummary,
  DraftView,
  DraftsView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

export const DRAFT_LIMIT = 30;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_URI = 2048;
const invalid = (field: string): never => {
  throw new ApiError(400, "invalid_request", `Invalid ${field}`);
};

function isWebUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function containsBinaryRepresentation(value: unknown): boolean {
  if (typeof value === "string")
    return value.trimStart().toLowerCase().startsWith("data:");
  if (Array.isArray(value))
    return value.some((item) => containsBinaryRepresentation(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([childKey, child]) =>
      [
        "image",
        "images",
        "attachments",
        "thumbnail",
        "previewUrl",
        "blob",
        "cid",
      ].includes(childKey) || containsBinaryRepresentation(child),
  );
}

function range(value: Record<string, unknown>, field: string) {
  if (
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    Number(value.start) < 0 ||
    Number(value.end) < Number(value.start)
  )
    invalid(field);
  return { start: value.start as number, end: value.end as number };
}

function strings(
  value: unknown,
  field: string,
  limit: number,
  maxLength: number,
) {
  if (!Array.isArray(value) || value.length > limit) invalid(field);
  return (value as unknown[]).map((item) => {
    if (typeof item !== "string" || item.length > maxLength) invalid(field);
    return item as string;
  });
}

export function parseDraftContent(input: unknown): DraftContent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("content");
  const raw = input as Record<string, unknown>;
  if (containsBinaryRepresentation(raw))
    invalid("content (binary fields are not supported)");
  if (
    typeof raw.text !== "string" ||
    [...raw.text].length > 3000 ||
    raw.text.length > 30_000
  )
    invalid("content.text");
  for (const key of ["mentions", "channels", "emojis"]) {
    if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).length > 100)
      invalid(`content.${key}`);
  }
  const mentions = (raw.mentions as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("content.mentions");
    const item = value as Record<string, unknown>;
    if (
      typeof item.did !== "string" ||
      !item.did.startsWith("did:") ||
      typeof item.handle !== "string" ||
      item.handle.length > 253
    )
      invalid("content.mentions");
    return {
      ...range(item, "content.mentions"),
      did: item.did as string,
      handle: item.handle as string,
    };
  });
  const channels = (raw.channels as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("content.channels");
    const item = value as Record<string, unknown>;
    if (
      typeof item.uri !== "string" ||
      !item.uri.startsWith("at://") ||
      item.uri.length > MAX_URI ||
      typeof item.name !== "string" ||
      item.name.length > 300
    )
      invalid("content.channels");
    return {
      ...range(item, "content.channels"),
      uri: item.uri as string,
      name: item.name as string,
    };
  });
  const emojis = (raw.emojis as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("content.emojis");
    const item = value as Record<string, unknown>;
    if (
      typeof item.uri !== "string" ||
      !item.uri.startsWith("at://") ||
      item.uri.length > MAX_URI
    )
      invalid("content.emojis");
    return { ...range(item, "content.emojis"), uri: item.uri as string };
  });
  const rawLinkCards = raw.linkCards;
  if (!Array.isArray(rawLinkCards) || rawLinkCards.length > 4)
    invalid("content.linkCards");
  const linkCards = (rawLinkCards as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("content.linkCards");
    const card = value as Record<string, unknown>;
    if ("thumbnail" in card || "previewUrl" in card || "cid" in card)
      invalid("content.linkCards");
    if (
      typeof card.uri !== "string" ||
      card.uri.length > MAX_URI ||
      !isWebUrl(card.uri)
    )
      invalid("content.linkCards.uri");
    if (typeof card.title !== "string" || card.title.length > 3000)
      invalid("content.linkCards.title");
    if (
      card.description !== undefined &&
      (typeof card.description !== "string" || card.description.length > 30_000)
    )
      invalid("content.linkCards.description");
    return {
      uri: card.uri as string,
      title: card.title as string,
      ...(typeof card.description === "string"
        ? { description: card.description }
        : {}),
    };
  });
  if (
    raw.quoteUri !== undefined &&
    (typeof raw.quoteUri !== "string" ||
      !raw.quoteUri.startsWith("at://") ||
      raw.quoteUri.length > MAX_URI)
  )
    invalid("content.quoteUri");
  return {
    text: raw.text as string,
    mentions,
    channels,
    emojis,
    linkCards,
    dismissedUrls: strings(
      raw.dismissedUrls,
      "content.dismissedUrls",
      100,
      MAX_URI,
    ).map((uri) => (isWebUrl(uri) ? uri : invalid("content.dismissedUrls"))),
    ...(typeof raw.quoteUri === "string" ? { quoteUri: raw.quoteUri } : {}),
  };
}

const parseDate = (value: unknown, field: string) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    invalid(field);
  return new Date(value as string);
};

export async function getDrafts(ownerDid: string): Promise<DraftsView> {
  const rows = await db
    .select()
    .from(nagiDrafts)
    .where(eq(nagiDrafts.ownerDid, ownerDid))
    .orderBy(desc(nagiDrafts.updatedAt));
  return {
    drafts: rows.map((row) => {
      const content = row.content as DraftContent;
      return {
        id: row.id,
        text: content.text,
        linkCardCount: content.linkCards.length,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      } satisfies DraftSummary;
    }),
    limit: DRAFT_LIMIT,
  };
}

export async function getDraft(
  ownerDid: string,
  id: unknown,
): Promise<DraftView> {
  if (typeof id !== "string" || !UUID_RE.test(id)) invalid("id");
  const draftId = id as string;
  const [row] = await db
    .select()
    .from(nagiDrafts)
    .where(and(eq(nagiDrafts.ownerDid, ownerDid), eq(nagiDrafts.id, draftId)))
    .limit(1);
  if (!row) throw new ApiError(404, "draft_not_found", "Draft not found");
  return {
    id: row.id,
    ...(row.content as DraftContent),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function putDraft(
  ownerDid: string,
  input: unknown,
): Promise<DraftView> {
  if (!input || typeof input !== "object") invalid("draft");
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !UUID_RE.test(raw.id)) invalid("id");
  const content = parseDraftContent(raw.content);
  const createdAt = parseDate(raw.createdAt, "createdAt");
  const updatedAt = parseDate(raw.updatedAt, "updatedAt");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerDid}))`);
    const [existing] = await tx
      .select({ ownerDid: nagiDrafts.ownerDid })
      .from(nagiDrafts)
      .where(eq(nagiDrafts.id, raw.id as string))
      .limit(1);
    if (existing && existing.ownerDid !== ownerDid)
      throw new ApiError(404, "draft_not_found", "Draft not found");
    if (!existing) {
      const [total] = await tx
        .select({ value: count(nagiDrafts.id) })
        .from(nagiDrafts)
        .where(eq(nagiDrafts.ownerDid, ownerDid));
      if (Number(total?.value ?? 0) >= DRAFT_LIMIT)
        throw new ApiError(
          409,
          "draft_limit",
          `Drafts are limited to ${DRAFT_LIMIT}`,
        );
    }
    if (existing) {
      await tx
        .update(nagiDrafts)
        .set({ content, updatedAt })
        .where(
          and(
            eq(nagiDrafts.id, raw.id as string),
            eq(nagiDrafts.ownerDid, ownerDid),
          ),
        );
    } else {
      await tx.insert(nagiDrafts).values({
        id: raw.id as string,
        ownerDid,
        content,
        createdAt,
        updatedAt,
      });
    }
    return {
      id: raw.id as string,
      ...content,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  });
}

export async function deleteDraft(ownerDid: string, id: unknown) {
  if (typeof id !== "string" || !UUID_RE.test(id)) invalid("id");
  const draftId = id as string;
  await db
    .delete(nagiDrafts)
    .where(and(eq(nagiDrafts.ownerDid, ownerDid), eq(nagiDrafts.id, draftId)));
  return { deleted: true as const };
}
