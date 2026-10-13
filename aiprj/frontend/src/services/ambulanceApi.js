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

export const sendLocation = async ({ ambulanceId, latitude, longitude, accuracy, heading, speed }) => {
  const response = await api.post('/ambulance/location', {
    ambulanceId,
    latitude,
    longitude,
    accuracy,
    heading,
    speed,
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

export const setTrafficDirection = async (direction) => {
  const response = await api.post('/emergency/test', { direction });
  return response.data;
};

export const clearTrafficDirection = async () => {
  const response = await api.post('/emergency/clear');
  return response.data;
};

export const setAdminTrafficDirection = async (direction) => {
  const response = await api.post('/admin/signal/override', { direction });
  return response.data;
};

export const clearAdminTrafficDirection = async () => {
  const response = await api.post('/admin/signal/clear');
  return response.data;
};

export const setAdminAllRed = async () => {
  const response = await api.post('/admin/signal/all-red');
  return response.data;
};

export default {
  startEmergency,
  sendLocation,
  stopEmergency,
  getAmbulanceStatus,
  setTrafficDirection,
  clearTrafficDirection,
  setAdminTrafficDirection,
  clearAdminTrafficDirection,
  setAdminAllRed,
};
