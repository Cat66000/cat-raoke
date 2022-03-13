import { youtube_v3 } from "googleapis";
import { googleapis_token } from "../loadedConfig";
const key = googleapis_token;

const youtubeClient = new youtube_v3.Youtube({
  http2: true,
  retry: true,
  timeout: 20e3,
});

export const searchVideos = async (query: string, maxResults: number = 10) => {
  const searchResults = await youtubeClient.search.list({
    q: query,
    part: ["id"],
    key,
    maxResults,
    type: ["video"],
  });

  return searchResults.data;
};
