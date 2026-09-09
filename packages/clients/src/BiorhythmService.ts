import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Ensure BIORHYTHM_SERVER_URL is available.
// In a shared package, we depend on the consumer to have the env var set, or we can set a default.
const getBiorhythmServerUrl = () => process.env.BIORHYTHM_SERVER_URL || "http://localhost:3002";

// biorhythm サーバーの /status・/energy エンドポイントが要求する共有シークレット。
const authConfig = () => {
  const secret = process.env.BIORHYTHM_INTERNAL_SECRET;
  return secret ? { headers: { Authorization: `Bearer ${secret}` } } : {};
};

export const botBiothythmManager = {
  getMood: async () => {
    try {
      const res = await axios.get(`${getBiorhythmServerUrl()}/status`, authConfig());
      return res.data.mood || "Normal";
    } catch (e) {
      return "Normal";
    }
  },
  addAffirmation: async (did: string) => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 10, type: "affirmation", did }, authConfig());
  },
  addDJ: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 20, type: "dj" }, authConfig());
  },
  addFortune: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 15, type: "fortune" }, authConfig());
  },
  addCheer: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 25, type: "cheer" }, authConfig());
  },
  addAnswer: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 15, type: "answer" }, authConfig());
  },
  addConversation: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 10, type: "conversation" }, authConfig());
  },
  addAnalysis: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 50, type: "analysis" }, authConfig());
  },
  addAnniversary: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 100, type: "anniversary" }, authConfig());
  },
  addLike: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 5, type: "like" }, authConfig());
  },
  addFollower: async () => {
    await axios.post(`${getBiorhythmServerUrl()}/energy`, { amount: 50, type: "follow" }, authConfig());
  },
  getContext: async (): Promise<{ mood: string; mood_en: string; energy: number; weather: string }> => {
    try {
      const res = await axios.get(`${getBiorhythmServerUrl()}/status`, authConfig());
      return {
        mood: res.data.mood || "",
        mood_en: res.data.mood_en || "",
        energy: res.data.energy || 0,
        weather: res.data.weather || "",
      };
    } catch (e) {
      return { mood: "", mood_en: "", energy: 0, weather: "" };
    }
  },
};
