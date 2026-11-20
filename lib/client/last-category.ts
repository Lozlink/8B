import { ALL_CATEGORY } from "./item-picker";

const KEY = "items-category";
let memory = ALL_CATEGORY;

/** The category staff last picked in the item grid. Kept for the life of the page (and tab, where storage allows). */
export function getLastCategory(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setLastCategory(key: string): void {
  memory = key;
  try {
    window.sessionStorage.setItem(KEY, key);
  } catch {
    // Storage can be unavailable (private mode); the in-memory copy still covers this page.
  }
}
