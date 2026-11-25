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
  rate: { dollars: number; per: string };
  staffSignInUrl: string;
  snacks: string;

  hero: { heading: string; lead: string; primaryCta: string };
  price: { heading: string[]; lead: string; splits: { players: number; line: string }[]; small: string };
  tables: { heading: string; lead: string };
  counter: { heading: string; lead: string };
  findUs: { heading: string; lead: string; mapsCta: string };
  /** What the enquiry form says on both the functions and contact pages (components/site/enquiry-form.tsx). */
  form: {
    submit: string;
    sentHeading: string;
    sentLead: string;
    /** Under the form, next to the button. */
    privacy: string;
  };
  /** The /functions page (components/site/functions.tsx). */
  functions: {
    navLabel: string;
    meta: { title: string; description: string };
    heading: string;
    lead: string;
    /** Follows the bookings answer in the FAQ and links to the page. */
    faqLink: string;
  };
  /** The /contact page (components/site/contact.tsx). */
  contact: {
    navLabel: string;
    meta: { title: string; description: string };
    heading: string;
    lead: string;
    /** In the Find us block on the home page, under the phone and email. */
    findUsLink: string;
  };
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
  /** One plain sentence on table size or make. Added to the end of the tables blurb. */
  tables_note: string | null;
  /**
   * Photos of the venue. Put the files in public/site/ and list them here; the "Have a look"
   * block appears once there is at least one. The first is shown largest, so lead with the best
   * shot of the room. `alt` says what is in the picture, for people who can't see it and for search.
   * Up to seven are shown. JPG or WebP, around 2000px on the long side, is plenty.
   */
  photos: { src: string; alt: string }[] | null;
  /** One plain sentence on parking. */
  parking: string | null;
  /** One plain sentence on age rules. */
  ageRules: string | null;
};

export const site: SiteContent = {
  name: "8 Ball Lounge",
  url: "https://8balllounge.com.au",
  address: {
    unitAndStreet: "Shop 3/46 Court Rd",
    suburb: "Fairfield",
    state: "NSW",
    postcode: "2165",
    country: "AU",
  },
  geo: { latitude: -33.8691932, longitude: 150.9579043 },
  tableCount: 7,
  rate: { dollars: 25, per: "hour" },
  staffSignInUrl: "https://app.8balllounge.com.au",
  snacks: "Chips, chocolate, biscuits and cold soft drinks",

  hero: {
    heading: "Rack 'em up, Fairfield.",
    lead: "Fairfield's pool hall. Seven tables, cold drinks, and all the time you want to settle it properly.",
    primaryCta: "Get directions",
  },
  price: {
    // One line each.
    heading: ["Twenty-five bucks an hour.", "For the whole table."],
    lead: "You pay for the table, not per head. Bring one mate or five and it costs the same, so the more of you there are, the less it stings.",
    splits: [
      { players: 2, line: "Two of you" },
      { players: 4, line: "Four of you" },
      { players: 5, line: "Five of you" },
    ],
    small: "Half an hour minimum. Same price every day of the week, GST and all.",
  },
  tables: {
    heading: "Seven tables. Pick one.",
    lead: "Walk in, point at a table and it's yours. Play one frame or stay until someone finally admits they're beaten. The clock runs for as long as you do.",
  },
  counter: {
    heading: "Thirsty work.",
    lead: "Chips, chocolate, biscuits and cold soft drinks at the counter. Put them on your table and fix up the lot at the end, card or cash.",
  },
  findUs: {
    heading: "Court Rd, Fairfield.",
    lead: "Come find us. Bring someone you reckon you can beat.",
    mapsCta: "Open in Google Maps",
  },
  functions: {
    navLabel: "Functions",
    meta: {
      title: "Functions and Work Parties in Fairfield | 8 Ball Lounge",
      description:
        "Work parties, team days and group nights at 8 Ball Lounge in Fairfield, Western Sydney. Seven pool tables, open 11 am till midnight every day. Send us the details.",
    },
    heading: "Bring the office.",
    lead: "The end-of-year party, or any excuse really. Tell us when and how many.",
    faqLink: "Give us a heads-up.",
  },
  contact: {
    navLabel: "Contact",
    meta: {
      title: "Contact | 8 Ball Lounge, Fairfield",
      description: "Get in touch with 8 Ball Lounge, the pool hall on Court Rd, Fairfield. Call, email or send us a message.",
    },
    heading: "Say g'day.",
    lead: "Ask away.",
    findUsLink: "Send us a message",
  },
  form: {
    submit: "Send it",
    sentHeading: "Got it.",
    sentLead: "We'll be in touch.",
    privacy: "We only use this to get back to you.",
  },
  faqHeading: "Before you ask",
  meta: {
    title: "Pool Hall in Fairfield, Sydney | 8 Ball Lounge",
    description:
      "A pool hall in Fairfield, Western Sydney. Seven pool tables at $25 an hour for the whole table, however many of you are playing. Open 11 am till midnight, every day.",
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
  bookings: "Tables are walk-in. Bringing a crew?",
  tables_note: null,
  // e.g. [{ src: "/site/room.jpg", alt: "Seven pool tables under hanging lamps" }]
  photos: [
    { src: "/site/billiards-club-table.jpg", alt: "A player lines up a shot on a green table under the red No. 01 Billiards Club light, with the drinks fridges behind" },
    { src: "/site/pool-tables.jpg", alt: "The main room: a row of blue pool tables, lounge chairs along the wall and games going on every table" },
    { src: "/site/green-table-game.jpg", alt: "A game on a green table while friends watch from the lounge chairs" },
    { src: "/site/counter-and-tables.jpg", alt: "Looking past the counter and its Open sign to the tables and the lounge" },
  ],
  parking: null,
  ageRules: null,
};

// Derived values and helpers. Pure: nothing here reads the clock.

export const fullAddress = `${site.address.unitAndStreet}, ${site.address.suburb} ${site.address.state} ${site.address.postcode}`;

export const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.name}, ${fullAddress}`)}`;

export const rateText = `$${site.rate.dollars} an ${site.rate.per}`;

/** "16:00" becomes "4 pm", "16:30" becomes "4:30 pm"; "24:00" and "00:00" are "midnight", "12:00" is "midday". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!m && h % 24 === 0) return "midnight";
  if (!m && h === 12) return "midday";
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/**
 * The hours in one line, when they are the same every day: "Open 11 am till midnight, every day."
 * Null when they aren't known or differ by day (the Find us block lists those row by row).
 */
export const hoursLine: string | null =
  site.hours?.length === 1 && site.hours[0].days.length === 7
    ? `Open ${formatTime(site.hours[0].opens)} till ${formatTime(site.hours[0].closes)}, every day.`
    : null;

export type FaqItem = {
  question: string;
  answer: string;
  /** Shown after the answer as a link. Search-engine data gets its label as plain text. */
  link?: { label: string; href: string };
};

/** Built from the facts above, so the page and the search-engine data never disagree. */
export const faqItems: FaqItem[] = [
  {
    question: "How much is a table?",
    answer: `${rateText} for the table, not per person. Split it between however many of you are playing. GST is included and it's the same price every day.`,
  },
  {
    question: "Is there a minimum?",
    answer: `Half an hour. After that you just pay for the time you play.`,
  },
  {
    question: "How many tables are there?",
    answer: `${site.tableCount}. Walk in and pick one.`,
  },
  {
    question: "Where are you?",
    answer: `${fullAddress}, in Sydney's west.`,
  },
  {
    question: "Can we get snacks and drinks?",
    answer: `Yes. ${site.snacks} at the counter. They go on your table's bill and you pay for everything at the end.`,
  },
  {
    question: "Card or cash?",
    answer: "Either.",
  },
  ...(site.hours
    ? [
        {
          question: "What are your opening hours?",
          answer: site.hours.map((r) => `${r.label}, ${formatTime(r.opens)} to ${formatTime(r.closes)}`).join(". ") + ".",
        },
      ]
    : []),
  ...(site.bookings
    ? [{ question: "Can I book a table?", answer: site.bookings, link: { label: site.functions.faqLink, href: "/functions" } }]
    : []),
  ...(site.parking ? [{ question: "Is there parking?", answer: site.parking }] : []),
  ...(site.ageRules ? [{ question: "Is there an age limit?", answer: site.ageRules }] : []),
];
