// One rule for "does this offer print its Make Of Bought Out Items section?", shared by the Offer PDF and the Sales
// Order Annexure PDF/Word so they can never disagree. Only an explicit show_bought_out = 0 hides it (NULL = a
// pre-toggle offer = show, same as 1), regardless of Standard/Spares format; an empty list prints nothing.
function showBoughtOutSection(offer, boughtOutRows) {
  return !!offer && offer.show_bought_out !== 0 && Array.isArray(boughtOutRows) && boughtOutRows.length > 0;
}
module.exports = { showBoughtOutSection };
