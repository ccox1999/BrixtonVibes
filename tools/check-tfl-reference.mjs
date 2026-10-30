// Read-only source check. The returned route is a line through stations; it
// does not verify the tunnel centreline or the two Brixton platform roads.
const url = 'https://api.tfl.gov.uk/Line/victoria/Route/Sequence/inbound?serviceTypes=Regular&excludeCrowding=true';
const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`TfL returned ${response.status}`);
const data = await response.json();
const points = JSON.parse(data.lineStrings[0])[0];
const stops = data.stopPointSequences[0].stopPoint;
console.log(JSON.stringify({ source: url, stationCount: data.stations.length,
  polylinePointCount: points.length,
  everyPolylinePointIsAStation: points.every(p => stops.some(s => p[0] === s.lon && p[1] === s.lat)),
  finalStations: stops.slice(-2).map(s => s.name),
  conclusion: 'Station-to-station geometry only; no verified crossover or separate platform-track geometry.' }, null, 2));
