package com.openbone.conformance;

import com.openbone.runtime.Json;
import com.openbone.runtime.ScriptHost;
import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.OpenBoneDocument;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicContainer;
import org.junit.jupiter.api.DynamicNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/** Every case of every conformance/expected/*.json (19 files) against the Java runtime. */
class ConformanceTest {
  static Path repo() {
    return Paths.get(System.getProperty("openbone.repo", "../.."));
  }

  static ScriptHost scriptHost() {
    // The QuickJS host lives in openbone-scripting; loaded reflectively so this module also runs without it.
    try {
      return (ScriptHost) Class.forName("com.openbone.scripting.QuickJsScriptHost").getDeclaredConstructor().newInstance();
    } catch (ReflectiveOperationException e) {
      return null;
    }
  }

  @TestFactory
  @SuppressWarnings("unchecked")
  Stream<DynamicNode> conformance() throws IOException {
    Path dir = repo().resolve("conformance/expected");
    String only = System.getProperty("openbone.only");
    List<Path> files;
    try (Stream<Path> s = Files.list(dir)) {
      files = s.filter(p -> p.toString().endsWith(".json")).sorted().collect(Collectors.toList());
    }
    if (files.isEmpty()) throw new IllegalStateException("No expected files in " + dir);
    ScriptHost host = scriptHost();
    List<DynamicNode> out = new ArrayList<>();
    for (Path f : files) {
      String name = f.getFileName().toString().replace(".json", "");
      if (only != null && !only.isEmpty() && !name.equals(only)) continue;
      Map<String, Object> exp = (Map<String, Object>) Json.parse(new String(Files.readAllBytes(f), StandardCharsets.UTF_8));
      OpenBoneDocument doc = DocumentLoader.load(Files.readAllBytes(repo().resolve((String) exp.get("document"))));
      ConformanceRunner runner = new ConformanceRunner(name, doc, host);
      List<DynamicNode> cases = new ArrayList<>();
      for (Object c : (List<Object>) exp.get("cases")) {
        Map<String, Object> cm = (Map<String, Object>) c;
        cases.add(DynamicTest.dynamicTest((String) cm.get("name"), () -> runner.runCase(cm)));
      }
      out.add(DynamicContainer.dynamicContainer(name, cases));
    }
    return out.stream();
  }
}
