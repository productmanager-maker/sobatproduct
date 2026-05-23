// Keyword yang bikin bot ikut nimbrung di grup tanpa di-mention
const TRIGGERS = [
  'sobat product',
  'sobatproduct',
  'menurut lu',
  'menurut lo',
  'gas bahas',
  'rangkum dong',
  'kasih ide',
  'ini maksudnya apa',
  'apa sih maksudnya',
  'tolong rangkum',
  'coba rangkum',
];

export function isTriggerKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => lower.includes(t));
}
