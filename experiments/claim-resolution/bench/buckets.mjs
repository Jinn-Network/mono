/**
 * Curation buckets. Each bucket is a topic + window brief handed to one
 * curator subprocess. Buckets exist only to spread the search; they are not
 * an experimental variable.
 *
 * Window rationale: the solver models' training cutoff is May 2026 and the
 * experiment ran on 2026-08-19. Claims resolving 2026-06-01..2026-08-15 are
 * post-cutoff, so they cannot be answered from parametric memory — the solver
 * has to research. The `historical-hard` bucket deliberately breaks that rule
 * to supply disputed oracle cases; those are flagged as contaminated.
 */

const POST_CUTOFF = 'a resolution deadline between 2026-06-01 and 2026-08-15';

export const BUCKETS = [
  { id: 'geopolitics', n: 12, window: POST_CUTOFF, brief: 'Geopolitics and armed conflict: ceasefires, peace agreements, troop deployments, sanctions, territorial control, diplomatic recognitions, hostage/prisoner releases.' },
  { id: 'elections', n: 12, window: POST_CUTOFF, brief: 'Elections, referendums, votes of no confidence, government formation, resignations and appointments of heads of state or government worldwide.' },
  { id: 'macro', n: 12, window: POST_CUTOFF, brief: 'Central bank decisions and macroeconomic data releases: Fed/ECB/BoE/BoJ/PBoC policy rates and guidance, CPI/PCE/PPI prints, unemployment, GDP revisions. Prefer claims that hinge on a specific threshold or on the exact wording of a statement rather than on a single headline number.' },
  { id: 'us-policy', n: 12, window: POST_CUTOFF, brief: 'US federal policy: legislation passing a chamber, executive orders, agency rulemaking, Supreme Court and appellate rulings, government shutdown/funding deadlines, tariff actions.' },
  { id: 'corporate', n: 12, window: POST_CUTOFF, brief: 'Corporate events: M&A completion or collapse, IPOs and direct listings, CEO/board departures, bankruptcies, index inclusions, large layoffs, regulatory fines against named companies.' },
  { id: 'crypto', n: 12, window: POST_CUTOFF, brief: 'Crypto and digital assets: protocol upgrades shipping, ETF/ETP approvals and launches, enforcement actions and settlements, exchange listings/delistings, major hacks and recoveries, stablecoin and treasury-company events. Avoid pure price-threshold claims unless the threshold is genuinely contested.' },
  { id: 'ai-tech', n: 12, window: POST_CUTOFF, brief: 'AI and technology: model and product releases, benchmark or capability milestones, chip export and supply decisions, major partnership or funding announcements, antitrust and platform regulation.' },
  { id: 'space-science', n: 10, window: POST_CUTOFF, brief: 'Space and science: launches and landings, mission milestones and failures, telescope/observatory results, notable retractions or replications, nuclear and fusion milestones.' },
  { id: 'intl-orgs', n: 10, window: POST_CUTOFF, brief: 'International organisations and blocs: OPEC+ quota decisions, EU legislation and enforcement, NATO decisions, UN Security Council resolutions, WHO declarations, WTO rulings, IMF programmes.' },
  { id: 'legal', n: 10, window: POST_CUTOFF, brief: 'Legal proceedings other than the US Supreme Court: indictments, verdicts, sentencings, extraditions, international tribunal rulings, high-profile civil judgments and settlements.' },
  { id: 'health-reg', n: 10, window: POST_CUTOFF, brief: 'Health and regulatory approvals: FDA/EMA approvals and rejections, clinical trial readouts, outbreak declarations, drug pricing and recall actions.' },
  { id: 'energy-commodities', n: 10, window: POST_CUTOFF, brief: 'Energy and commodities: production decisions, pipeline and LNG milestones, refinery and grid events, commodity price thresholds tied to a specific settlement reference, weather/climate records declared by an official body.' },
  { id: 'culture', n: 10, window: POST_CUTOFF, brief: 'Culture and media, excluding sports results: awards outcomes, box office thresholds, chart records, book/film/album releases slipping or landing, notable institutional appointments.' },
  { id: 'compound', n: 12, window: POST_CUTOFF, brief: 'Deliberately compound or conjunctive claims across any domain: "A and B both happen by D", "A happens before B", "X exceeds T on at least N days", "official body Y uses the exact phrase Z". These should require several distinct pieces of evidence to be assembled, and should be resolvable but genuinely fiddly.' },
  { id: 'historical-hard', n: 14, window: 'any historical resolution date, including well before 2026', brief: 'Genuinely contested oracle questions that were escalated, disputed, or resolved controversially on Reality.eth/Kleros, Omen, Augur, UMA/Polymarket or a comparable public-resolution system. Cases where the resolution turned on the exact wording of the criteria, on which source counted, or on a close call. Include the documented dispute in the notes.' },
];
