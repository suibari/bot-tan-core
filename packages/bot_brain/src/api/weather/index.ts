import https from 'https';
import axios from 'axios';

interface OpenMeteoResponse {
    current_weather: {
        temperature: number;
        windspeed: number;
        winddirection: number;
        weathercode: number;
        is_day: number;
        time: string;
    };
}

// WMO Weather interpretation codes (WW)
// https://open-meteo.com/en/docs
const weatherCodeMap: Record<number, string> = {
    0: '快晴',
    1: '晴れ',
    2: '晴れ時々曇り',
    3: '曇り',
    45: '霧',
    48: '霧氷',
    51: '霧雨',
    53: '霧雨',
    55: '霧雨',
    56: '霧雨',
    57: '霧雨',
    61: '雨',
    63: '雨',
    65: '雨',
    66: '雨',
    67: '雨',
    71: '雪',
    73: '雪',
    75: '雪',
    77: '雪',
    80: 'にわか雨',
    81: 'にわか雨',
    82: 'にわか雨',
    85: '雪',
    86: '雪',
    95: '雷雨',
    96: '雷雨',
    99: '雷雨',
};

const WEATHER_REQUEST_TIMEOUT_MS = 5_000;

export async function getYokohamaWeather(): Promise<string> {
    const response = await axios.get<OpenMeteoResponse>(
        'https://api.open-meteo.com/v1/forecast?latitude=35.4437&longitude=139.638&current_weather=true&timezone=Asia%2FTokyo',
        {
            httpsAgent: new https.Agent({ family: 4 }), // IPv4でないとアクセスできない
            timeout: WEATHER_REQUEST_TIMEOUT_MS,
        }
    );
    const code = response.data.current_weather.weathercode;
    return weatherCodeMap[code] || '不明';
}
