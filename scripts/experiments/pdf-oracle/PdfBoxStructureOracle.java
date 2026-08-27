/*
 * Temporary, body-free PDFBox oracle used by pdf-oracle-spike.ts.
 *
 * Its default mode reports only structural aggregates. The optional
 * --materialize mode is consumed through an in-memory pipe by the Bun spike;
 * that caller removes cell text before emitting its body-free report.
 */
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageTree;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkedContentReference;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDObjectReference;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.documentinterchange.markedcontent.PDMarkedContent;
import org.apache.pdfbox.text.PDFMarkedContentExtractor;
import org.apache.pdfbox.text.TextPosition;

public final class PdfBoxStructureOracle {
  private static final class Kid {
    String kind;
    int pageIndex;
    int mcid;
    Node node;
  }

  private static final class Node {
    String role;
    String actualText;
    int pageIndex;
    final List<Kid> kids = new ArrayList<Kid>();
  }

  private static final class Counters {
    int nodes;
    int elementKids;
    int mcidKids;
    int objectKids;
    int unknownKids;
    int cycles;
    int crossPageElementEdges;
    final Map<String, Integer> roles = new TreeMap<String, Integer>();
  }

  private static final class TableSummary {
    int index;
    int rowCount;
    int cellCount;
    int headerCellCount;
    int dataCellCount;
    int emptyCellCount;
    int unresolvedCellCount;
    final List<Integer> rowCellCounts = new ArrayList<Integer>();
    final Set<Integer> pages = new LinkedHashSet<Integer>();
    final List<List<String>> materializedRows = new ArrayList<List<String>>();
    final List<List<List<String>>> materializedReferences = new ArrayList<List<List<String>>>();
  }

  private PdfBoxStructureOracle() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 1 || args.length > 2 || (args.length == 2 && !"--materialize".equals(args[1]))) {
      System.err.println("usage: PdfBoxStructureOracle <pdf> [--materialize]");
      System.exit(2);
    }
    try (PDDocument document = Loader.loadPDF(new File(args[0]))) {
      printSummary(document, args.length == 2);
    }
  }

  private static void printSummary(PDDocument document, boolean includeMaterializedText) throws IOException {
    PDPageTree pages = document.getPages();
    Map<String, String> mcidText = extractMcidText(document, pages);
    PDStructureTreeRoot root = document.getDocumentCatalog().getStructureTreeRoot();
    Counters counters = new Counters();
    List<Node> roots = new ArrayList<Node>();
    Set<COSDictionary> visiting = Collections.newSetFromMap(new IdentityHashMap<COSDictionary, Boolean>());
    if (root != null) {
      for (Object kid : root.getKids()) {
        if (kid instanceof PDStructureElement) {
          roots.add(readNode((PDStructureElement) kid, pages, -1, counters, visiting));
        } else {
          counters.unknownKids += 1;
        }
      }
    }

    List<Node> tables = new ArrayList<Node>();
    for (Node node : roots) collectRole(node, "Table", tables);
    List<TableSummary> tableSummaries = new ArrayList<TableSummary>();
    for (int index = 0; index < tables.size(); index += 1) {
      tableSummaries.add(summarizeTable(index, tables.get(index), mcidText));
    }

    StringBuilder json = new StringBuilder();
    json.append('{');
    field(json, "schema", "atlcli.pdfbox-structure-oracle/1");
    comma(json);
    field(json, "engine", "Apache PDFBox 3.0.8");
    comma(json);
    numberField(json, "pages", pages.getCount());
    comma(json);
    booleanField(json, "tagged", root != null);
    comma(json);
    numberField(json, "nodeCount", counters.nodes);
    comma(json);
    json.append("\"kidCounts\":{");
    numberField(json, "element", counters.elementKids);
    comma(json);
    numberField(json, "mcid", counters.mcidKids);
    comma(json);
    numberField(json, "object", counters.objectKids);
    comma(json);
    numberField(json, "unknown", counters.unknownKids);
    json.append('}');
    comma(json);
    numberField(json, "cycleCount", counters.cycles);
    comma(json);
    numberField(json, "crossPageElementEdgeCount", counters.crossPageElementEdges);
    comma(json);
    json.append("\"roleCounts\":");
    appendIntegerMap(json, counters.roles);
    comma(json);
    json.append("\"tables\":[");
    for (int index = 0; index < tableSummaries.size(); index += 1) {
      if (index > 0) comma(json);
      appendTable(json, tableSummaries.get(index), includeMaterializedText);
    }
    json.append(']');
    json.append('}');
    System.out.println(json.toString());
  }

  private static Node readNode(
      PDStructureElement element,
      PDPageTree pages,
      int inheritedPageIndex,
      Counters counters,
      Set<COSDictionary> visiting) {
    Node result = new Node();
    String standardRole = element.getStandardStructureType();
    result.role = standardRole == null || standardRole.length() == 0
        ? nullToEmpty(element.getStructureType())
        : standardRole;
    result.actualText = nullToEmpty(element.getActualText());
    result.pageIndex = pageIndex(pages, element.getPage(), inheritedPageIndex);
    counters.nodes += 1;
    increment(counters.roles, result.role);

    COSDictionary identity = element.getCOSObject();
    if (!visiting.add(identity)) {
      counters.cycles += 1;
      return result;
    }
    try {
      for (Object rawKid : element.getKids()) {
        Kid kid = new Kid();
        kid.pageIndex = result.pageIndex;
        kid.mcid = -1;
        if (rawKid instanceof PDStructureElement) {
          kid.kind = "element";
          counters.elementKids += 1;
          kid.node = readNode((PDStructureElement) rawKid, pages, result.pageIndex, counters, visiting);
          kid.pageIndex = kid.node.pageIndex;
          if (result.pageIndex >= 0 && kid.pageIndex >= 0 && result.pageIndex != kid.pageIndex) {
            counters.crossPageElementEdges += 1;
          }
        } else if (rawKid instanceof COSInteger || rawKid instanceof Integer) {
          kid.kind = "mcid";
          kid.mcid = rawKid instanceof COSInteger
              ? ((COSInteger) rawKid).intValue()
              : ((Integer) rawKid).intValue();
          counters.mcidKids += 1;
        } else if (rawKid instanceof PDMarkedContentReference) {
          PDMarkedContentReference reference = (PDMarkedContentReference) rawKid;
          kid.kind = "mcid";
          kid.mcid = reference.getMCID();
          kid.pageIndex = pageIndex(pages, reference.getPage(), result.pageIndex);
          counters.mcidKids += 1;
        } else if (rawKid instanceof PDObjectReference) {
          PDObjectReference reference = (PDObjectReference) rawKid;
          kid.kind = "object";
          kid.pageIndex = pageIndex(pages, reference.getPage(), result.pageIndex);
          counters.objectKids += 1;
        } else {
          kid.kind = "unknown";
          counters.unknownKids += 1;
        }
        result.kids.add(kid);
      }
    } finally {
      visiting.remove(identity);
    }
    return result;
  }

  private static Map<String, String> extractMcidText(PDDocument document, PDPageTree pages)
      throws IOException {
    Map<String, String> result = new LinkedHashMap<String, String>();
    for (int pageIndex = 0; pageIndex < pages.getCount(); pageIndex += 1) {
      PDFMarkedContentExtractor extractor = new PDFMarkedContentExtractor();
      extractor.setSuppressDuplicateOverlappingText(false);
      extractor.processPage(pages.get(pageIndex));
      for (PDMarkedContent content : extractor.getMarkedContents()) {
        collectMarkedContent(pageIndex, content, result);
      }
    }
    return result;
  }

  private static String collectMarkedContent(
      int pageIndex,
      PDMarkedContent content,
      Map<String, String> target) {
    StringBuilder text = new StringBuilder();
    for (Object item : content.getContents()) {
      if (item instanceof TextPosition) {
        String unicode = ((TextPosition) item).getUnicode();
        if (unicode != null) text.append(unicode);
      } else if (item instanceof PDMarkedContent) {
        text.append(collectMarkedContent(pageIndex, (PDMarkedContent) item, target));
      }
    }
    int mcid = content.getMCID();
    if (mcid >= 0) {
      String key = mcidKey(pageIndex, mcid);
      target.put(key, nullToEmpty(target.get(key)) + text.toString());
    }
    return text.toString();
  }

  private static TableSummary summarizeTable(
      int index,
      Node table,
      Map<String, String> mcidText) {
    TableSummary summary = new TableSummary();
    summary.index = index;
    List<Node> rows = new ArrayList<Node>();
    collectRole(table, "TR", rows);
    summary.rowCount = rows.size();
    for (Node row : rows) {
      List<Node> cells = new ArrayList<Node>();
      List<String> materializedCells = new ArrayList<String>();
      List<List<String>> materializedCellReferences = new ArrayList<List<String>>();
      for (Kid kid : row.kids) {
        if (kid.node != null && ("TH".equals(kid.node.role) || "TD".equals(kid.node.role))) {
          cells.add(kid.node);
        }
      }
      summary.rowCellCounts.add(Integer.valueOf(cells.size()));
      for (Node cell : cells) {
        summary.cellCount += 1;
        if ("TH".equals(cell.role)) summary.headerCellCount += 1;
        if ("TD".equals(cell.role)) summary.dataCellCount += 1;
        Set<String> visitedMcids = new LinkedHashSet<String>();
        collectPagesAndMcids(cell, summary.pages, visitedMcids);
        int textCharacters = codePoints(cell.actualText);
        boolean unresolved = false;
        for (String key : visitedMcids) {
          String value = mcidText.get(key);
          if (value == null) {
            summary.unresolvedCellCount += 1;
            unresolved = true;
          }
          else textCharacters += codePoints(value);
        }
        if (textCharacters == 0 && !unresolved) summary.emptyCellCount += 1;
        materializedCells.add(materializeNode(cell, mcidText));
        materializedCellReferences.add(new ArrayList<String>(visitedMcids));
      }
      summary.materializedRows.add(materializedCells);
      summary.materializedReferences.add(materializedCellReferences);
    }
    List<Integer> sortedPages = new ArrayList<Integer>(summary.pages);
    Collections.sort(sortedPages);
    summary.pages.clear();
    summary.pages.addAll(sortedPages);
    return summary;
  }

  private static String materializeNode(Node node, Map<String, String> mcidText) {
    if (node.actualText.length() > 0) return node.actualText;
    StringBuilder text = new StringBuilder();
    for (Kid kid : node.kids) {
      if (kid.node != null) text.append(materializeNode(kid.node, mcidText));
      else if ("mcid".equals(kid.kind) && kid.pageIndex >= 0 && kid.mcid >= 0) {
        text.append(nullToEmpty(mcidText.get(mcidKey(kid.pageIndex, kid.mcid))));
      }
    }
    return text.toString();
  }

  private static void collectPagesAndMcids(Node node, Set<Integer> pages, Set<String> mcids) {
    if (node.pageIndex >= 0) pages.add(Integer.valueOf(node.pageIndex));
    for (Kid kid : node.kids) {
      if (kid.pageIndex >= 0) pages.add(Integer.valueOf(kid.pageIndex));
      if ("mcid".equals(kid.kind) && kid.pageIndex >= 0 && kid.mcid >= 0) {
        mcids.add(mcidKey(kid.pageIndex, kid.mcid));
      }
      if (kid.node != null) collectPagesAndMcids(kid.node, pages, mcids);
    }
  }

  private static void collectRole(Node node, String role, List<Node> target) {
    if (role.equals(node.role)) target.add(node);
    for (Kid kid : node.kids) if (kid.node != null) collectRole(kid.node, role, target);
  }

  private static int pageIndex(PDPageTree pages, PDPage page, int fallback) {
    if (page == null) return fallback;
    int index = pages.indexOf(page);
    return index < 0 ? fallback : index;
  }

  private static String mcidKey(int pageIndex, int mcid) {
    return pageIndex + ":" + mcid;
  }

  private static int codePoints(String value) {
    return value == null ? 0 : value.codePointCount(0, value.length());
  }

  private static String nullToEmpty(String value) {
    return value == null ? "" : value;
  }

  private static void increment(Map<String, Integer> map, String key) {
    Integer previous = map.get(key);
    map.put(key, Integer.valueOf((previous == null ? 0 : previous.intValue()) + 1));
  }

  private static void appendTable(
      StringBuilder json,
      TableSummary summary,
      boolean includeMaterializedText) {
    json.append('{');
    numberField(json, "index", summary.index);
    comma(json);
    numberField(json, "rowCount", summary.rowCount);
    comma(json);
    numberField(json, "cellCount", summary.cellCount);
    comma(json);
    numberField(json, "headerCellCount", summary.headerCellCount);
    comma(json);
    numberField(json, "dataCellCount", summary.dataCellCount);
    comma(json);
    numberField(json, "emptyCellCount", summary.emptyCellCount);
    comma(json);
    numberField(json, "unresolvedCellCount", summary.unresolvedCellCount);
    comma(json);
    json.append("\"pages\":");
    appendIntegerCollection(json, summary.pages);
    comma(json);
    json.append("\"rowCellCounts\":");
    appendIntegerCollection(json, summary.rowCellCounts);
    if (includeMaterializedText) {
      comma(json);
      json.append("\"materializedRows\":[");
      for (int rowIndex = 0; rowIndex < summary.materializedRows.size(); rowIndex += 1) {
        if (rowIndex > 0) comma(json);
        json.append('[');
        List<String> row = summary.materializedRows.get(rowIndex);
        for (int cellIndex = 0; cellIndex < row.size(); cellIndex += 1) {
          if (cellIndex > 0) comma(json);
          string(json, row.get(cellIndex));
        }
        json.append(']');
      }
      json.append(']');
      comma(json);
      json.append("\"materializedReferences\":[");
      for (int rowIndex = 0; rowIndex < summary.materializedReferences.size(); rowIndex += 1) {
        if (rowIndex > 0) comma(json);
        json.append('[');
        List<List<String>> row = summary.materializedReferences.get(rowIndex);
        for (int cellIndex = 0; cellIndex < row.size(); cellIndex += 1) {
          if (cellIndex > 0) comma(json);
          json.append('[');
          List<String> references = row.get(cellIndex);
          for (int referenceIndex = 0; referenceIndex < references.size(); referenceIndex += 1) {
            if (referenceIndex > 0) comma(json);
            string(json, references.get(referenceIndex));
          }
          json.append(']');
        }
        json.append(']');
      }
      json.append(']');
    }
    json.append('}');
  }

  private static void appendIntegerMap(StringBuilder json, Map<String, Integer> values) {
    json.append('{');
    boolean first = true;
    for (Map.Entry<String, Integer> entry : values.entrySet()) {
      if (!first) comma(json);
      first = false;
      string(json, entry.getKey());
      json.append(':').append(entry.getValue().intValue());
    }
    json.append('}');
  }

  private static void appendIntegerCollection(StringBuilder json, Iterable<Integer> values) {
    json.append('[');
    boolean first = true;
    for (Integer value : values) {
      if (!first) comma(json);
      first = false;
      json.append(value.intValue());
    }
    json.append(']');
  }

  private static void field(StringBuilder json, String name, String value) {
    string(json, name);
    json.append(':');
    string(json, value);
  }

  private static void numberField(StringBuilder json, String name, int value) {
    string(json, name);
    json.append(':').append(value);
  }

  private static void booleanField(StringBuilder json, String name, boolean value) {
    string(json, name);
    json.append(':').append(value ? "true" : "false");
  }

  private static void string(StringBuilder json, String value) {
    json.append('"');
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      if (character == '"' || character == '\\') json.append('\\').append(character);
      else if (character == '\n') json.append("\\n");
      else if (character == '\r') json.append("\\r");
      else if (character == '\t') json.append("\\t");
      else if (character < 0x20) json.append(String.format("\\u%04x", Integer.valueOf(character)));
      else json.append(character);
    }
    json.append('"');
  }

  private static void comma(StringBuilder json) {
    json.append(',');
  }
}
