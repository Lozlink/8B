/**
 * Everything the public site says, in one place. Edit here and the page, the search-engine
 * data and the share card all follow. Fields set to null are things we do not know yet: the
 * matching block stays off the page until a value is filled in.
 */

export type DayName = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

export type HoursRow = {
  /** How the row reads on the page, e.g. "Monday to Friday" or "Weekends". */
  label: string;
  /** Days this row covers, used for search-engine data. */
  days: DayName[];
  /** 24-hour "HH:MM", e.g. "16:00". */
  opens: string;
  /** 24-hour "HH:MM", e.g. "23:00". */
  closes: string;
};

export type SiteContent = {
  name: string;
  url: string;
  address: {
    unitAndStreet: string;
    suburb: string;
    state: string;
    postcode: string;
    country: string;
  };
  geo: { latitude: number; longitude: number };
  tableCount: number;
  openedOn: string;
  rate: { dollars: number; per: string };
  minimumMinutes: number;
  staffSignInUrl: string;
  snacks: string;
  payment: string;

  hero: { heading: string; lead: string; primaryCta: string; secondaryCta: string };
  pricing: { heading: string; lead: string };
  expect: { heading: string; lead: string };
  findUs: { heading: string; lead: string; mapsCta: string };
  faqHeading: string;
  meta: { title: string; description: string; ogAlt: string };

  // Not known yet. Fill in to switch the matching block on.
  /** Opening hours. Adds an Hours block and opening hours to the search-engine data. */
  hours: HoursRow[] | null;
  /** Phone number as people dial it, e.g. "02 9999 9999". */
  phone: string | null;
  /** Public email address. */
  email: string | null;
  /** Full URLs of social accounts, e.g. { label: "Instagram", url: "https://instagram.com/..." }. */
  social: { label: string; url: string }[] | null;
  /** One plain sentence on bookings, e.g. how to book or that walk-ins only are taken. */
  bookings: string | null;
  /** One plain sentence on table size or make. */
  tables: string | null;
  /** One plain sentence on parking. */
  parking: string | null;
  /** One plain sentence on age rules. */
  ageRules: string | null;
};

export const site: SiteContent = {
  name: "8 Ball Lounge",
  url: "https://8balllounge.com.au",
  address: {
    unitAndStreet: "3/46 Court Rd",
    suburb: "Fairfield",
    state: "NSW",
    postcode: "2165",
    country: "AU",
  },
  geo: { latitude: -33.8691932, longitude: 150.9579043 },
  tableCount: 7,
  openedOn: "November 2026",
  rate: { dollars: 25, per: "hour" },
  minimumMinutes: 30,
  staffSignInUrl: "https://app.8balllounge.com.au",
  snacks: "Chips, chocolate, biscuits and soft drinks",
  payment: "Card and cash",

  hero: {
    heading: "Pool tables in Fairfield",
    lead: "A pool hall in Sydney's west with seven tables. Come in, pick a table and play.",
    primaryCta: "See pricing",
    secondaryCta: "Find us",
  },
  pricing: {
    heading: "Pricing",
    lead: "You pay for the table, not for each person. The rate is the same every day.",
  },
  expect: {
    heading: "What to expect",
    lead: "Here is how it works when you walk in.",
  },
  findUs: {
    heading: "Find us",
    lead: "We are on Court Rd in Fairfield.",
    mapsCta: "Open in Google Maps",
  },
  faqHeading: "Questions",
  meta: {
    title: "Pool Tables in Fairfield, Sydney | 8 Ball Lounge",
    description:
      "8 Ball Lounge has 7 pool tables in Fairfield, in Sydney's west. $25 an hour per table, the same every day. Find us at 3/46 Court Rd, Fairfield.",
    ogAlt: "8 Ball Lounge, pool tables in Fairfield",
  },

  hours: [ {
    label: "Monday to Sunday",
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    opens: "11:00",
    closes: "24:00",
  }],
  phone: '0445 455 471',
  email: 'info@8balllounge.com.au',
  social: [ { label: 'Instagram', url: 'https://www.instagram.com/8.balllounge/'}],
  bookings: null,
  tables: null,
  parking: null,
  ageRules: null,
};

// Derived values and helpers. Pure: nothing here reads the clock.

export const fullAddress = `${site.address.unitAndStreet}, ${site.address.suburb} ${site.address.state} ${site.address.postcode}`;

export const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.name}, ${fullAddress}`)}`;

export const rateText = `$${site.rate.dollars} an ${site.rate.per}`;

/** "16:00" becomes "4 pm", "16:30" becomes "4:30 pm". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

export type FaqItem = { question: string; answer: string };

/** Built from the facts above, so the page and the search-engine data never disagree. */
export const faqItems: FaqItem[] = [
  {
    question: "How much does a table cost?",
    answer: `${rateText} per table, not per person. GST is included and the rate is the same every day.`,
  },
  {
    question: "Is there a minimum time?",
    answer: `Yes, ${site.minimumMinutes} minutes. After that you pay for the time you play.`,
  },
  {
    question: "How many tables do you have?",
    answer: `${site.tableCount} pool tables.`,
  },
  {
    question: "Where are you?",
    answer: `${fullAddress}. We are in Fairfield, in Sydney's west.`,
  },
  {
    question: "Can I buy snacks and drinks?",
    answer: `Yes. The counter sells ${site.snacks.toLowerCase()}.`,
  },
  {
    question: "Do you take card?",
    answer: `${site.payment} are both fine.`,
  },
  {
    question: "When did you open?",
    answer: `${site.openedOn}.`,
  },
  ...(site.hours
    ? [
        {
          question: "What are your opening hours?",
          answer: site.hours.map((r) => `${r.label}, ${formatTime(r.opens)} to ${formatTime(r.closes)}`).join(". ") + ".",
        },
      ]
    : []),
  ...(site.bookings ? [{ question: "Can I book a table?", answer: site.bookings }] : []),
  ...(site.parking ? [{ question: "Is there parking?", answer: site.parking }] : []),
  ...(site.ageRules ? [{ question: "Is there an age limit?", answer: site.ageRules }] : []),
];
