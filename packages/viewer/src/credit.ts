/**
 * The credit line every artefact orca hands out carries.
 *
 * Two surfaces show it — the exported HTML page (`html.ts`) and the SVG cards the CLI renders
 * (`cli/src/share-card.ts`) — and they have to agree, because a run someone forwards is often the
 * first time anyone sees this project's name. It lived as a duplicated literal in both packages
 * until they had to say something longer than the repo URL; one constant is what stops them
 * drifting the next time it changes.
 *
 * Split into two halves because the media differ: the HTML footer is one line with no width to
 * respect, while a 720px card sets the halves against opposite margins. Together they are 95
 * characters, which is why the card sets them a size smaller than its other rows — at 11px the two
 * halves leave 37px between them, close enough that a monospace fallback advancing wider than the
 * one this was measured in would overlap them. At 10px the gap is 94px and no fallback closes it.
 */

/** Who made the thing you are looking at. */
export const CREDIT_MADE_BY = 'Recorded with OrcaReplay · built by the @OrcaRouter team';

/** Where to go next. Deliberately the repository, not a product page. */
export const CREDIT_REPO = 'github.com/Continuum-AI-Corp/OrcaReplay';

/** Both halves, for a surface with room for one line. */
export const CREDIT_LINE = `${CREDIT_MADE_BY} · ${CREDIT_REPO}`;
