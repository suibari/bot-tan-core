import { BotFeature } from "./types.js";
import { AnniversaryFeature } from "./AnniversaryFeature.js";
import { LimitedFeature } from "./LimitedFeature.js";
import { FrequencyFeature } from "./FrequencyFeature.js";
import { DiaryFeature } from "./DiaryFeature.js";
import { FortuneFeature } from "./FortuneFeature.js";
import { AnalyzeFeature } from "./AnalyzeFeature.js";
import { DJFeature } from "./DJFeature.js";
import { CheerFeature } from "./CheerFeature.js";
import { ConversationFeature } from "./ConversationFeature.js";
import { NormalReplyFeature } from "./NormalReplyFeature.js";
import { RecapYearFeature } from "./RecapYearFeatures.js";

export const features: BotFeature[] = [
    new AnniversaryFeature(),
    new LimitedFeature(),
    new FrequencyFeature(),
    new DiaryFeature(),
    new FortuneFeature(),
    new AnalyzeFeature(),
    new DJFeature(),
    new CheerFeature(),
    new RecapYearFeature(),
    new ConversationFeature(),
    new NormalReplyFeature(),
];
