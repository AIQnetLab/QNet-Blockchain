// "On this page": the sections of a long document as links to their anchors, beside its reading column on a wide
// screen (styles/pages.css hides it where the column takes the whole width).

export type TocItem = readonly [id: string, title: string];

export default function DocToc({ items }: { items: readonly TocItem[] }) {
  return (
    <nav className="doc-aside toc-aside" aria-labelledby="toc-h">
      <p className="label toc-h" id="toc-h">On this page</p>
      <ul className="toc">
        {items.map(([id, title]) => (
          <li key={id}><a className="toc-link" href={`#${id}`}>{title}</a></li>
        ))}
      </ul>
    </nav>
  );
}
