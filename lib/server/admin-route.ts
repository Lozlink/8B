import "server-only";
import { requireActor, requireElevation, type Actor, type Manager } from "./auth";

/** Every admin route: a signed-in staff session on this device + a live manager elevation. */
export async function requireAdmin(): Promise<{ actor: Actor; manager: Manager }> {
  const actor = await requireActor();
  const manager = await requireElevation(actor);
  return { actor, manager };
}
