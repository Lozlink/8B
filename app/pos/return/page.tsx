"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { errorMessage } from "@/lib/client/errors";

type Outcome = { result: "paid" | "canceled" | "pending" | "error"; message: string };

const HEADLINE: Record<Outcome["result"], string> = {
  paid: "Cash recorded",
  canceled: "Cash sale cancelled",
  pending: "Not confirmed yet",
  error: "Something went wrong",
};

const DEFAULT_TEXT: Record<Outcome["result"], string> = {
  paid: "Go back to the table timer.",
  canceled: "The cash sale was cancelled in Square. The bill is still unpaid.",
  pending: "Square hasn't confirmed the sale yet. Go back to the table timer and tap Check again on the bill.",
  error: "Go back to the table timer and look at the bill before taking the cash again.",
};

/**
 * Square POS lands here (in Safari, no cookies needed) after a cash sale. It passes the result in the
 * `data` query parameter; we hand it to the server and show one outcome.
 */
export default function PosReturnPage() {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const started = useRef(false);

  const send = useCallback(async () => {
    setOutcome(null);
    const data = new URLSearchParams(window.location.search).get("data");
    if (!data) {
      setOutcome({ result: "error", message: "Nothing came back from Square. Go back to the table timer and look at the bill." });
      return;
    }
    try {
      setOutcome(await api.posReturn(data));
    } catch (e) {
      setOutcome({ result: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void send();
    // A browser with a staff session gets a button back to the floor.
    api
      .me()
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, [send]);

  const paid = outcome?.result === "paid";
  useEffect(() => {
    if (!paid || !signedIn) return;
    const id = setTimeout(() => router.replace("/"), 2500);
    return () => clearTimeout(id);
  }, [paid, signedIn, router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      {!outcome ? (
        <Spinner label="Checking with Square" />
      ) : (
        <>
          <h1
            className={`text-5xl font-bold ${outcome.result === "paid" ? "" : outcome.result === "error" ? "text-danger" : "text-warn"}`}
          >
            {HEADLINE[outcome.result]}
          </h1>
          <p className="max-w-xl text-2xl text-muted">{outcome.message || DEFAULT_TEXT[outcome.result]}</p>
          {outcome.result === "pending" || outcome.result === "error" ? (
            <Button size="lg" onClick={() => void send()}>
              Try again
            </Button>
          ) : null}
          {signedIn ? (
            <Button variant="primary" size="lg" onClick={() => router.replace("/")}>
              Back to the floor
            </Button>
          ) : null}
        </>
      )}
    </main>
  );
}
