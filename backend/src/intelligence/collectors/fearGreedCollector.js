import axios from 'axios';

const URL = 'https://api.alternative.me/fng/?limit=2&format=json';

export const fearGreedCollector = {
  async collect() {
    const res  = await axios.get(URL, { timeout: 5000 });
    const data = res.data.data;
    const now  = data[0];
    const prev = data[1];
    return {
      value:     parseInt(now.value),
      label:     now.value_classification,
      change24h: parseInt(now.value) - parseInt(prev.value),
      timestamp: new Date(parseInt(now.timestamp) * 1000),
    };
  }
};
