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
 * respect, while a 720px card sets the halves against opposite margins. Together they are 97
 * characters, which is why the card sets them a size smaller than its other rows — at 11px they
 * leave 24px between them, and a monospace fallback advancing 0.66em rather than the usual 0.6em
 * overlaps them by 40px. At 10px the gap is 82px and no plausible fallback closes it.
 */

/** Who made the thing you are looking at. */
export const CREDIT_MADE_BY = 'Recorded with OrcaReplay · built by the OrcaRouter.ai team';

/** Where to go next. Deliberately the repository, not a product page. */
export const CREDIT_REPO = 'github.com/Continuum-AI-Corp/OrcaReplay';

/** Both halves, for a surface with room for one line. */
export const CREDIT_LINE = `${CREDIT_MADE_BY} · ${CREDIT_REPO}`;
