/** A screen from a later phase: what it will do, and when. */
export function Placeholder({ title, phase, about }: { title: string; phase: number; about: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="lede">{about}</p>
      <div className="card">
        <p className="note">
          This screen arrives in Phase {phase}. Its logic is already ported and checked against the desktop app — what's
          left is the screen itself.
        </p>
      </div>
    </section>
  );
}
