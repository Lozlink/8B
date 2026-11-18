"use client";

export default function GlobalError() {
  return (
    <html lang="en-AU">
      <body style={{ background: "#0a0a0a", color: "#f4f1ec", fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.75rem" }}>Something went wrong</h1>
        <p style={{ color: "#aaa49c", fontSize: "1.1rem" }}>Reload to carry on. If it keeps happening, write start times on the paper sheet.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ marginTop: "1.5rem", minHeight: 56, padding: "0 2rem", fontSize: "1.1rem", fontWeight: 600, borderRadius: 12, border: 0, background: "#2c7a55", color: "#fff" }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
