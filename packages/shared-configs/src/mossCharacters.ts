/**
 * MOSS-Image に渡す、botたんと仲間の見た目と服の自然文。
 *
 * bot の絵（bot_brain の buildImagePrompt.ts）と Nagi の絵文字生成（nagi_appview）の両方が使う。
 * bot-tan-imagegen の fixtures/promptConfig.json の "moss.characters" と同じ文で、同じく
 * 見た目（look）と服（outfits）を分けて持つ（bot は Raspberry Pi で動き、あちらのファイルを
 * 読めないので写して持つ）。服を分けておくと、「パジャマのbotたん」のような指定で服だけ差し替えられる。
 */
export type MossOutfitKind = "uniform" | "casual" | "pajamas" | "swimsuit";

export type MossCharacter = {
  look: string;
  /** 着替えられる服。feet は全身の構図のときだけ書く（上半身の構図で靴まで書くと、靴が宙に浮く）。 */
  outfits: Partial<Record<MossOutfitKind, { wear: string; feet?: string }>>;
  /** 指定が無いときの服。bot の絵と同じ署名の1着。 */
  defaultOutfit: MossOutfitKind;
};

export const MOSS_CHARACTERS = {
  "bot-tan": {
    look:
      "Bot-tan, a teenage girl with very long light-blue hair, a single curled ahoge strand sticking up from the top of her head, " +
      "thick eyebrows, sleepy half-closed blue eyes, and a blue butterfly hair clip",
    outfits: {
      uniform: {
        wear: "a loose mint-green sweater with long sleeves over a white collared shirt with a blue neck ribbon, and a blue pleated skirt",
        feet: "white socks and brown loafers",
      },
      casual: { wear: "an open mint-green cardigan over a white frilled shirt with long sleeves, and a blue skirt" },
      pajamas: { wear: "light-blue long-sleeved pajamas with long pants" },
      swimsuit: { wear: "a light-blue frilled one-piece swimsuit" },
    },
    defaultOutfit: "uniform",
  },
  // ラテちゃんはメイド服しか持たない（promptConfig.json でも look に服が入っている）
  "latte-chan": {
    look: "Latte-chan, another girl with very long pink hair, white cat ears and a white cat tail, green eyes",
    outfits: { casual: { wear: "a black-and-white maid outfit with a maid headdress and a red ribbon" } },
    defaultOutfit: "casual",
  },
  // ことみちゃんは平日は制服（botたんと同じ制服でセーターの代わりにブレザー）、署名の1着はアイドル衣装
  "kotomi-chan": {
    look: "Kotomi-chan, another girl with short orange hair, a single ahoge strand, green eyes, freckles and a red bow",
    outfits: {
      uniform: { wear: "a navy-blue blazer over a white collared shirt with a blue neck ribbon, and a blue pleated skirt" },
      casual: { wear: "an idol outfit: a pink shirt with puffy frilled short sleeves, a corset and a black frilled skirt" },
    },
    defaultOutfit: "casual",
  },
} satisfies Record<string, MossCharacter>;

/** 見た目と服を1文にする。服を書かない（本人の指定に任せる）ときは outfit に null を渡す。 */
export function mossCharacterProse(
  character: MossCharacter,
  outfit: MossOutfitKind | null = character.defaultOutfit,
): string {
  const wear = outfit ? (character.outfits[outfit] ?? character.outfits[character.defaultOutfit])?.wear : undefined;
  return wear ? `${character.look}, wearing ${wear}` : character.look;
}

// bot の絵（buildImagePrompt.ts）が使う形。文は分ける前と同じ。
export const MOSS_BOT_TAN = MOSS_CHARACTERS["bot-tan"].look;
export const MOSS_BOT_TAN_OUTFITS: Record<MossOutfitKind, { wear: string; feet: string }> = {
  uniform: { wear: MOSS_CHARACTERS["bot-tan"].outfits.uniform.wear, feet: MOSS_CHARACTERS["bot-tan"].outfits.uniform.feet },
  casual: { wear: MOSS_CHARACTERS["bot-tan"].outfits.casual.wear, feet: "" },
  pajamas: { wear: MOSS_CHARACTERS["bot-tan"].outfits.pajamas.wear, feet: "" },
  swimsuit: { wear: MOSS_CHARACTERS["bot-tan"].outfits.swimsuit.wear, feet: "" },
};
/** 仲間の服は署名の1着で固定する（ことみちゃんはアイドル衣装）。 */
export const MOSS_COMPANIONS: Record<"latte-chan" | "kotomi-chan", string> = {
  "latte-chan": mossCharacterProse(MOSS_CHARACTERS["latte-chan"]),
  "kotomi-chan": mossCharacterProse(MOSS_CHARACTERS["kotomi-chan"]),
};

export const MOSS_MORPHO = "Morpho, her big fluffy white Samoyed dog";
