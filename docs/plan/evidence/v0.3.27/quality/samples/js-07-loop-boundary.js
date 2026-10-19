// Sample js-07 — boundary (defect)
// The loop condition reads one element past the end, so the reducer receives
// undefined and the sum becomes NaN whenever the cart is non-empty.
function cartTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i += 1) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

module.exports = { cartTotal };
