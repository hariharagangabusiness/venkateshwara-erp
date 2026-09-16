// Generates internal-use EAN-13 barcodes for the Item Master.
// GS1 reserves the 200-299 prefix range for internal/in-store use (never
// allocated to real products), so item barcodes here start with "20" and
// are safe to print and scan without colliding with any real GTIN.
function ean13CheckDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(digits12[i]);
    sum += (i % 2 === 0) ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

// seq: a positive integer (e.g. the item's row id) used to make the code
// unique and stable across reseeds/imports.
function generateItemBarcode(seq) {
  const body = '20' + String(seq).padStart(10, '0'); // 12 digits, prefix 20
  const check = ean13CheckDigit(body);
  return body + check;
}

module.exports = { generateItemBarcode, ean13CheckDigit };
