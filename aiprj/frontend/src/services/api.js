import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../config';

const API_BASE_URL = `${BASE_URL}/api`;

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const uploadVideo = async (file, roadName) => {
  const formData = new FormData();
  // 'road' MUST be appended before 'video': multer's diskStorage
  // destination/filename callbacks fire as soon as the file field is
  // reached in the multipart stream, using only the fields parsed so far.
  // Appending 'road' after 'video' means req.body.road is still undefined
  // at that point, so every upload was silently falling back to "unknown".
  formData.append('road', roadName);
  formData.append('video', file);

  const response = await axios.post(`${API_BASE_URL}/upload`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  return response.data;
};

// Video analysis runs real YOLOv8 detection + tracking over 4 videos
// sequentially on the CPU, which can genuinely take several minutes. No
// timeout here would leave a truly hung request spinning forever with no
// feedback; a very generous 15-minute cap turns that into a clear error
// instead of an indefinite freeze.
export const analyzeTraffic = async (videos) => {
  const response = await api.post('/analyze', { videos }, { timeout: 15 * 60 * 1000 });
  return response.data;
};

export const analyzeWebcamFrame = async (image, road) => {
  const response = await api.post('/analyze-frame', { image, road });
  return response.data;
};

export const startSignalCycle = async (counts, direction) => {
  const response = await api.post('/signal/start', { counts, direction });
  return response.data;
};

export const getSignalStatus = async () => {
  const response = await api.get('/signal/status');
  return response.data;
};

export const resetSignalCycle = async () => {
  const response = await api.post('/signal/reset');
  return response.data;
};

export default {
  uploadVideo,
  analyzeTraffic,
  analyzeWebcamFrame,
  startSignalCycle,
  getSignalStatus,
  resetSignalCycle,
};
