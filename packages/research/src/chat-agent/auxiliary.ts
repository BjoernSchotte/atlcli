export type ChatAuxiliaryReadNeedV1 = "comments" | "metadata";

const COMMENT_NEED_V1 = /\b(?:comments?|kommentar(?:e|en|s)?)\b/iu;
const METADATA_NEED_V1 =
  /\b(?:labels?|tags?|metadata|metadaten|ancestors?|parents?|properties|versions?|schlagw[oö]rter|vorfahren|übergeordnete|eigenschaften|versionen?)\b/iu;

/**
 * Conservative host-owned admission for optional Atlassian projections.
 * Model text cannot widen it: only the user's normalized question is read.
 */
export function deriveChatAuxiliaryReadNeedsV1(
  question: string,
): ChatAuxiliaryReadNeedV1[] {
  const needs: ChatAuxiliaryReadNeedV1[] = [];
  if (COMMENT_NEED_V1.test(question)) needs.push("comments");
  if (METADATA_NEED_V1.test(question)) needs.push("metadata");
  return needs;
}
