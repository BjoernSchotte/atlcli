import { getCollection, type CollectionEntry } from "astro:content";
import { publicationRoutePath } from "@atlcli/web-publish-astro-spike";

function orderedPages(pages: CollectionEntry<"publicationPages">[]) {
  return pages.sort((left, right) =>
    left.data.position - right.data.position || left.data.title.localeCompare(right.data.title),
  );
}

export async function getPublicationPaths(locale: string) {
  const pages = await getCollection("publicationPages");
  const localePages = orderedPages(pages.filter((entry) => entry.data.locale === locale));
  const navigation = localePages
    .map((entry) => ({
      label: entry.data.title,
      link: `${publicationRoutePath(entry.data)}/`,
      locale: entry.data.locale,
      position: entry.data.position,
    }));
  const byId = new Map(pages.map((entry) => [entry.data.id, entry]));
  return localePages.map((entry) => {
      const route = publicationRoutePath(entry.data);
      const prefix = locale === "en" ? "/publish" : `/${locale}/publish`;
      const suffix = route.slice(prefix.length).replace(/^\//u, "");
      const breadcrumbs = [];
      let cursor: CollectionEntry<"publicationPages"> | undefined = entry;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.data.id)) {
        seen.add(cursor.data.id);
        breadcrumbs.unshift({
          label: cursor.data.title,
          link: `${publicationRoutePath(cursor.data)}/`,
        });
        cursor = cursor.data.parentId ? byId.get(cursor.data.parentId) : undefined;
      }
      const related = localePages
        .filter((candidate) => candidate.data.id !== entry.data.id)
        .map((candidate) => {
          const sharedLabels = candidate.data.labels.filter((label) => entry.data.labels.includes(label)).length;
          const sameParent = Boolean(entry.data.parentId && candidate.data.parentId === entry.data.parentId);
          const hierarchy = candidate.data.parentId === entry.data.id || entry.data.parentId === candidate.data.id;
          return {
            label: candidate.data.title,
            link: `${publicationRoutePath(candidate.data)}/`,
            score: sharedLabels * 10 + (sameParent ? 3 : 0) + (hierarchy ? 2 : 0),
            position: candidate.data.position,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.position - right.position || left.label.localeCompare(right.label))
        .slice(0, 3);
      return {
        params: { slug: suffix || undefined },
        props: { breadcrumbs, entry, navigation, related },
      };
    });
}

export async function getLabelPaths(locale: string) {
  const pages = orderedPages((await getCollection("publicationPages")).filter((entry) => entry.data.locale === locale));
  const labels = [...new Set(pages.flatMap((entry) => entry.data.labels))]
    .filter((label) => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(label))
    .sort();
  return labels.map((label) => ({
    params: { label },
    props: {
      entries: pages.filter((entry) => entry.data.labels.includes(label)),
      label,
      navigation: pages.map((entry) => ({
        label: entry.data.title,
        link: `${publicationRoutePath(entry.data)}/`,
      })),
    },
  }));
}
