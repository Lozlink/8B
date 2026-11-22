"use client";

import { useRef, useState, type FocusEvent } from "react";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { NAME_MAX, NOTE_MAX, charsLeft, checkDetails, detailsOf, savedMessage, type BillDetails } from "@/lib/client/bill-details";
import { billCan, billName } from "@/lib/client/bill-view";
import { useAction } from "@/lib/client/use-action";
import { useScanHandler } from "@/lib/client/use-scan-handler";
import type { SessionDTO } from "@/lib/domain/types";

/**
 * After the keyboard comes up, bring the field into view inside the sheet. The wait lets the iPad
 * keyboard finish sliding in first; scrolling sooner measures the screen as it was without it.
 */
function keepClearOfKeyboard(e: FocusEvent<HTMLElement>) {
  const el = e.currentTarget;
  window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 350);
}

// ---------------------------------------------------------------------------
// The edit dialog
// ---------------------------------------------------------------------------

interface DialogProps {
  /** The bill (or share) being named. */
  sessionId: string;
  /** What the bill is called, shown above the fields: "Table 3", "Counter sale". */
  subject: string;
  /**
   * What the bill has now. The fields are filled from this once, when the dialog opens: a refresh
   * of the floor behind it never changes what someone is typing.
   */
  initial: BillDetails;
  onClose: () => void;
  /** After a save, once the dialog is closed. */
  onSaved?: () => void | Promise<void>;
}

/** One small sheet: a name (up to 40 characters) and a note (up to 200). Both are sent on every save. */
export function DetailsDialog({ sessionId, subject, initial, onClose, onSaved }: DialogProps) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [name, setName] = useState(() => initial.customerName ?? "");
  const [note, setNote] = useState(() => initial.note ?? "");
  // What the bill had when the dialog opened: what "changed" is measured against.
  const [seed] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // A barcode scanner types like a keyboard. While this is open a scan must not add an item to the
  // bill behind it (or start a counter sale), so it takes the scans and drops them.
  useScanHandler(() => undefined, true);

  const check = checkDetails(name, note, seed);
  const emptied = check.ok && check.details.customerName === null && check.details.note === null;
  const hadSomething = seed.customerName !== null || seed.note !== null;

  const submit = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (!check.changed) {
      onClose();
      return;
    }
    setError(null);
    const done = await run(
      async () => {
        await api.setDetails(sessionId, check.changes);
        return true as const;
      },
      { inline: setError },
    );
    if (done) {
      toast.show(savedMessage(seed, check.details), "success");
      onClose();
      await onSaved?.();
    }
  };

  return (
    <Sheet title="Name and note" onClose={onClose} raised locked={pending}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-lg font-semibold">{subject}</p>

        <Field label="Name" hint={`${charsLeft(name.length, NAME_MAX)}. Who the bill is for.`}>
          <input
            className={inputClass}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="Name"
            disabled={pending}
            onFocus={keepClearOfKeyboard}
            onKeyDown={(e) => {
              // Next goes to the note; saving is the Save button (or Return in the note).
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                noteRef.current?.focus();
              }
            }}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>

        <Field label="Note" hint={`${charsLeft(note.length, NOTE_MAX)}. Shown on the table and the Unpaid list.`}>
          <textarea
            ref={noteRef}
            className={`${inputClass} min-h-24 resize-none py-3`}
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            placeholder="Note"
            disabled={pending}
            onFocus={keepClearOfKeyboard}
            onKeyDown={(e) => {
              // Return saves. A note is one line, so it never takes a line break.
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (check.ok && check.changed && !pending) void submit();
              }
            }}
            onChange={(e) => {
              setNote(e.target.value.replace(/[\r\n]+/g, " "));
              setError(null);
            }}
          />
        </Field>

        {emptied && hadSomething ? <p className="text-base text-muted">Saving will remove the name and note.</p> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Button size="lg" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button size="lg" variant="primary" type="submit" disabled={!check.ok || !check.changed || pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
          <Button
            disabled={pending || (name === "" && note === "")}
            onClick={() => {
              setName("");
              setNote("");
              setError(null);
            }}
          >
            Clear name and note
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// On the bill's own sheets
// ---------------------------------------------------------------------------

interface SectionProps {
  session: SessionDTO;
  /** After a save: reload the sheet. (The floor is refreshed by the request itself.) */
  onSaved: () => void | Promise<void>;
  /** Something else is going on: hold the edit button. */
  disabled?: boolean;
}

/**
 * The bill's name and note, with a button to change them while the bill is open. Once it is paid
 * or void they are only shown (and the box is left out if there is nothing to show).
 */
export function BillDetailsSection({ session, onSaved, disabled = false }: SectionProps) {
  const [open, setOpen] = useState(false);
  const editable = billCan(session, "set_details");
  const { customerName, note } = session;
  if (!editable && !customerName && !note) return null;
  return (
    <section aria-label="Name and note" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line px-4 py-3">
      <dl className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div>
          <dt className="text-sm font-semibold text-muted">Name</dt>
          <dd className={customerName ? "break-words text-xl font-semibold" : "text-base text-muted"}>{customerName ?? "No name"}</dd>
        </div>
        {note ? (
          <div>
            <dt className="text-sm font-semibold text-muted">Note</dt>
            <dd className="break-words text-base">{note}</dd>
          </div>
        ) : null}
      </dl>
      {editable ? (
        <Button disabled={disabled} onClick={() => setOpen(true)} aria-label={customerName || note ? "Change name or note" : "Add name or note"}>
          {customerName || note ? "Change" : "Add name"}
        </Button>
      ) : null}
      {open ? (
        <DetailsDialog
          sessionId={session.id}
          subject={billName(session)}
          initial={detailsOf(session)}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      ) : null}
    </section>
  );
}
