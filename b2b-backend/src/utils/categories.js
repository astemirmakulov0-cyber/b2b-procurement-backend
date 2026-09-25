// RFQ categories. Biddex launches one category at a time: RFQs can only be posted in an active one; the rest
// are shown as "Coming soon". The frontend has the same lists (index.html, RFQ_CATEGORIES).
const ACTIVE_CATEGORIES = ['Restaurants & Cafés'];
const COMING_SOON_CATEGORIES = ['Beauty & Salons', 'Construction', 'Generators & Machinery', 'Rental Cars', 'Office & Facilities', 'General'];
// earlier names, still sent by pages loaded before the rename (migration 8 renamed stored RFQs)
const LEGACY_NAMES = { 'Restaurant Groceries': 'Restaurants & Cafés' };

// { value } for an active category (legacy names mapped), { error } otherwise
function checkCategory(raw) {
  const name = typeof raw === 'string' ? (LEGACY_NAMES[raw.trim()] || raw.trim()) : '';
  if (ACTIVE_CATEGORIES.includes(name)) return { value: name };
  if (COMING_SOON_CATEGORIES.includes(name)) return { error: `The category "${name}" is coming soon; RFQs can be posted in: ${ACTIVE_CATEGORIES.join(', ')}` };
  return { error: 'category must be one of: ' + ACTIVE_CATEGORIES.join(', ') };
}

module.exports = { ACTIVE_CATEGORIES, COMING_SOON_CATEGORIES, LEGACY_NAMES, checkCategory };
