// Prefilled defaults for a new offer, taken from the standard Venkateshwara
// Engineers techno-commercial offer template. All of these are editable and
// extendable per-offer once created — this only sets the starting point so
// staff aren't typing the same boilerplate on every quotation.

const TECH_SPECS = [
  ['Equipment Operating Temperature within Plant', 'Ambient Temperature'],
  ['Type', 'Electronic'],
  ['Voltage', '+/- 10 % of specified supply Voltage'],
  ['Frequency', '+/- 3 % of specified supply'],
  ['Noise Level', '<75 DB'],
  ['Application', 'Open Mouth Weighing and Bagging Line'],
  ['Type of feeder', 'Gravity Feeder (Three Speed- Three Gate)'],
  ['Material To Be Handled', ''],
  ['Flow Characteristics', 'Free Flowing'],
  ['Bulk Density (Mt/Cu.Mt)', ''],
  ['Weighment Size', ''],
  ['Capacity Bags Per Min (Depending upon operator’s efficiency)', ''],
  ['Accuracy At 2 sigma', '+/- 0.1 % at 2 Sigma (Min 20-40 Grams)'],
  ['Type of Bag', 'Open Mouth'],
  ['Bag Size', 'Customer to Specify'],
];

const BOUGHT_OUT_ITEMS = [
  ['Load Cell', 'Tedea Huntleigh'],
  ['Controller', 'Venkateshwara (VE-01)'],
  ['Relays', 'Siemens'],
  ['Motor', 'BBL/ABB/Havells'],
  ['Gear box', 'Bonfiglioli'],
  ['Air Cylinders', 'Janatics'],
  ['Solenoid Valves', 'Festo'],
  ['Sewing Head', 'Gabbar Eng VM 802 Model'],
];

const TERMS = [
  ['Price Basis', 'Ex-Works Faridabad Basis'],
  ['Delivery', '14-16 Weeks from Receipt Of P.O. Along With Adv.'],
  ['Packing & Forwarding', '@ 2%'],
  ['GST', '@18% (HSN Code - 84233000) (As Applicable)'],
  ['Freight & Insurance', 'To Pay Basis'],
  ['Guarantee/Warrantee', 'One Year from The Date Of Commissioning or 18 Months From The Date Of Supply, Which Ever Is Earlier'],
  ['Payment Terms', '40% Advance, Balance Against Proforma Invoice Before Dispatch'],
];

const INCLUSIONS = `Supervision of Erection & Commissioning. However, customers provide To & Fro Travel Expenses (Ex Faridabad 3 Tier AC Train Fare), Lodging, boarding and local conveyance at site at no cost to vendor during all visits for installation, commissioning, and warranty period.`;

const EXCLUSIONS = `Support Structure
Erection
Unskilled laborers and material handling equipments for erection
All Civil Work
Unloading of equipments at site and shifting of equipments to location
Incoming Power Supply & Its Wiring
Instrument Air Supply & Its Piping
Stamping By W&M Department at Site`;

const UTILITIES_REQUIREMENT = `Power Supply: 415V AC +/- 10%, 50 Hz +/- 3%, 3 Phase with Earth and Neutral at Input Terminal of main panel`;

const INSTRUMENT_AIR_SUPPLY = `At 5-6 Kg/Sq.Cm at Inlet Of FRL on each bagging line.
Connection 1/4" BSP (Female)
Instrument Air Consumption: 5.0 Cu.M/Hr.`;

module.exports = { TECH_SPECS, BOUGHT_OUT_ITEMS, TERMS, INCLUSIONS, EXCLUSIONS, UTILITIES_REQUIREMENT, INSTRUMENT_AIR_SUPPLY };
