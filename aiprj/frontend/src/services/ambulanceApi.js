import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../config';

const API_BASE_URL = `${BASE_URL}/api`;

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 8000,
});

export const startEmergency = async (ambulanceId) => {
  const response = await api.post('/ambulance/start', { ambulanceId });
  return response.data;
};

export const sendLocation = async ({ ambulanceId, latitude, longitude, accuracy, emergency }) => {
  const response = await api.post('/ambulance/location', {
    ambulanceId,
    latitude,
    longitude,
    accuracy,
    emergency,
  });
  return response.data;
};

export const stopEmergency = async (ambulanceId) => {
  const response = await api.post('/ambulance/stop', { ambulanceId });
  return response.data;
};

export const getAmbulanceStatus = async () => {
  const response = await api.get('/ambulance/status');
  return response.data;
};

export default { startEmergency, sendLocation, stopEmergency, getAmbulanceStatus };
