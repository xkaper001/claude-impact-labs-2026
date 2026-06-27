'use strict';
/** Node-side data loading (the browser/PouchDB build would replace this). */

const fs = require('fs');
const path = require('path');
const { parseCSV } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'claude-impact-labs-data', 'claude-impact-lab-mumbai-2026', 'data');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config-scoring.json'), 'utf8'));
}

function loadCSV(name) {
  return parseCSV(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

function loadRecords() { return loadCSV('Synthetic_Missing_Persons_2500.csv'); }
function loadZones() { return loadCSV('Zone_Boundaries.csv'); }
function loadChokepoints() { return loadCSV('Chokepoints_Parking.csv'); }
function loadPoliceStations() { return loadCSV('Police_Stations.csv'); }

module.exports = {
  ROOT, DATA_DIR,
  loadConfig, loadRecords, loadZones, loadChokepoints, loadPoliceStations,
};
