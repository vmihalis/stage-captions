import { HttpError } from './errors.mjs';

function text(value, label, max, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new HttpError(400, `${label} is invalid.`);
  return value.trim();
}

export function validateTeamPatch(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Provide team settings as a JSON object.');
  const team = { ...current };
  if (Object.hasOwn(body, 'name')) team.name = text(body.name, 'Team name', 80, { empty: false });
  if (Object.hasOwn(body, 'glossary')) {
    const glossary = body.glossary;
    if (!glossary || !Array.isArray(glossary.terms) || !Array.isArray(glossary.translationTerms) || glossary.terms.length > 100 || glossary.translationTerms.length > 100) {
      throw new HttpError(400, 'Provide up to 100 vocabulary terms and 100 translation preferences.');
    }
    const terms = [...new Set(glossary.terms.map((term) => text(term, 'Vocabulary term', 100, { empty: false })))];
    const translationTerms = glossary.translationTerms.map((term) => ({
      source: text(term?.source, 'Source term', 100, { empty: false }),
      target: text(term?.target, 'Translated term', 100, { empty: false }),
    }));
    const background = text(glossary.background, 'Presentation background', 6000);
    const totalLength = background.length + terms.join('').length + translationTerms.reduce((length, term) => length + term.source.length + term.target.length, 0);
    if (totalLength > 12000) throw new HttpError(400, 'Keep the combined vocabulary and background under 12,000 characters.');
    team.glossary = { terms, translationTerms, background };
  }
  return team;
}
