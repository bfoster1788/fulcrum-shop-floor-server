// Mock data used when MOCK_MODE=true, so this server runs and is reviewable end-to-end before
// Brian has generated a real Fulcrum Public API token. Shapes mirror what the real API returns
// (per the OpenAPI schema and the fields confirmed during design); equipment below is Impulse's
// actual equipment list (pulled live via Fulcrum on 2026-09-08), everything else is invented.

export const equipment = [
  { id: '65e24709ee304fc577517321', name: 'D1', description: 'DMU 50, DMG MORI, 5-Axis Mill', workCenterName: 'CNC Machining' },
  { id: '65e24709ee304fc577517322', name: 'D2', description: 'DMU 75, DMG MORI, 5-Axis Mill, w/ PH150', workCenterName: 'CNC Machining' },
  { id: '67928fc4316ec73557eb3fb7', name: 'D3', description: 'DMC 75, DMG MORI, 5-Axis Mill, w/RPS', workCenterName: 'CNC Machining' },
  { id: '6a32d9f66348b302b60bddd4', name: 'H1', description: 'C650, Hermle, 5-Axis Mill, w/ flexHeavy', workCenterName: 'CNC Machining' },
  { id: '65e24709ee304fc577517323', name: 'M1', description: 'UCP 600 Vario, Mikron, 5-axis Mill, w/ pallet automation', workCenterName: 'CNC Machining' },
  { id: '6a32de8a2a70ef9f2ee644db', name: 'M2', description: 'HPM450U, Mikron, 5-axis Mill, w/ pallet automation', workCenterName: 'CNC Machining' },
  { id: '6a32dead6348b302b60bdeab', name: 'M3', description: 'HPM450U, Mikron, 5-axis Mill, w/ pallet automation', workCenterName: 'CNC Machining' },
  { id: '6a32dedfa9363035678a3324', name: 'M4', description: 'HPM450U, Mikron, 5-axis Mill, w/ pallet automation', workCenterName: 'CNC Machining' },
  { id: '65e24709ee304fc577517324', name: 'O1', description: 'M560 V, OKUMA, 3-Axis Mill, w/ 4th Axis', workCenterName: 'CNC Machining' },
];

export const jobs = [
  {
    id: 'mock-job-1', systemJobNumber: 1570, jobName: 'sample for SOP', status: 'In Progress',
    customerName: 'Xometry', itemName: 'XPWA212128 - 5th stage Assembly', quantityToMake: 1,
  },
  {
    id: 'mock-job-2', systemJobNumber: 1642, jobName: 'bracket run', status: 'In Progress',
    customerName: 'Acme Aerospace', itemName: 'AC-4471 Mount Bracket', quantityToMake: 40,
  },
];

export const users = [
  { id: '6a2836095c1346467db87fb9', firstName: 'Brian', lastName: 'Foster', roles: ['Administrator'] },
  { id: 'mock-user-feld', firstName: 'Dana', lastName: 'Feld', roles: ['Operator'] },
  { id: 'mock-user-ortega', firstName: 'Marco', lastName: 'Ortega', roles: ['Operator'] },
];
