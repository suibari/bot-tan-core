import { Modality, PartListUnion } from "@google/genai";
import { gemini } from "./index.js";
import * as fs from "node:fs";
import { SYSTEM_INSTRUCTION } from "@bsky-affirmative-bot/shared-configs";
import { withRoute } from "./aiRoute.js";


export async function generateImage(mood: string): Promise<Buffer | null> {
  const prompt =
    `Please create your illustration using the attached character design as a reference.
  The 1st attached character's name is "Fully-Affirmative Bot-tan".
  The 2nd attached character's name is "Latte-chan".
  Please faithfully maintain the following characteristics. You may change the outfit to suit the scene.
  * Fully-Affirmative Bot-tan
    - Light blue hair, long hair, ahoge
    - Thick eyebrows, squinting eyes
  * Morpho
    - a Samoyed dog
    - not show up at school
  * Latte-chan
    - pink hair, long princess hair, red ribbon
    - nekomimi
    - green eyes
    - maid clothes
    - a red hairpin with the kanji character "ten (heaven)"
    - white cat tail
    - not show up at school
  Rules: 
  * **Be careful not to lose balance between the body and face.**
  * **Do not include text in images**
  Scene: ${mood}`;

  const imagePath_bottan = "./img/bot-tan-concept.png";
  const imageData_bottan = fs.readFileSync(imagePath_bottan);
  const base64Image_bottan = imageData_bottan.toString("base64");
  const imagePath_latte = "./img/latte-chan-concept.png";
  const imageData_latte = fs.readFileSync(imagePath_latte);
  const base64Image_latte = imageData_latte.toString("base64");
  const contents: PartListUnion = [
    { text: prompt },
    {
      inlineData: {
        mimeType: "image/png",
        data: base64Image_bottan,
      },
    },
    {
      inlineData: {
        mimeType: "image/png",
        data: base64Image_latte,
      },
    },
  ];

  const response = await gemini.models.generateContent(withRoute("BSKY_IMAGE", {
    contents,
    // config: {
    //   // systemInstruction: SYSTEM_INSTRUCTION,
    //   responseModalities: [Modality.IMAGE],
    // }
  }));



  for (const part of response.candidates?.[0].content?.parts || []) {
    if (part.text) {
      console.log("[INFO][IMGGEN] Generated image prompt:", part.text);
    } else if (part.inlineData) {
      console.log("[INFO][IMGGEN] Generated image received.");
      const imageData = part.inlineData.data;
      if (imageData) {
        const buffer = Buffer.from(imageData, 'base64');
        fs.writeFileSync("./img/output.png", buffer);
        console.log("[INFO][IMGGEN] Image saved to ./img/output.png");
        return buffer; // Return the buffer
      }
    }
  }
  return null; // Return null if no image data was found
}
