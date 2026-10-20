package gauntlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.pitest.bytecode.analysis.ClassTree;
import org.pitest.mutationtest.build.InterceptorParameters;
import org.pitest.mutationtest.build.InterceptorType;
import org.pitest.mutationtest.build.MutationInterceptor;
import org.pitest.mutationtest.build.MutationInterceptorFactory;
import org.pitest.mutationtest.engine.Mutater;
import org.pitest.mutationtest.engine.MutationDetails;
import org.pitest.plugin.Feature;
import org.pitest.plugin.FeatureParameter;

/**
 * Gauntlet's filter for `mutation ... on changed` (spec 0019). Turned on with
 * +gauntletlines(file[path]), it keeps only the mutants on the lines the file
 * lists, one "package/path/Source.kt:line" per line: the package the mutated
 * class is in and its source file, which is all Pitest knows of where a
 * mutant is. Everything else is dropped before coverage and before any
 * mutant runs. Registered through the ServiceLoader on Pitest's classpath.
 */
public final class ChangedLines implements MutationInterceptorFactory, MutationInterceptor {
    private static final FeatureParameter FILE = FeatureParameter.named("file").withDescription("the file of package/Source.kt:line entries to keep");

    private final Set<String> lines;

    public ChangedLines() {
        this(new HashSet<String>());
    }

    private ChangedLines(Set<String> lines) {
        this.lines = lines;
    }

    @Override
    public String description() {
        return "Gauntlet: mutate only the lines a change added or edited";
    }

    @Override
    public Feature provides() {
        return Feature.named("gauntletlines").withOnByDefault(false).withDescription(description()).withParameter(FILE);
    }

    @Override
    public MutationInterceptor createInterceptor(InterceptorParameters params) {
        String file = params.getString(FILE).orElseThrow(() -> new IllegalArgumentException("gauntletlines needs file[...]"));
        try {
            Set<String> kept = new HashSet<String>();
            for (String line : Files.readAllLines(Paths.get(file), StandardCharsets.UTF_8)) {
                if (!line.trim().isEmpty()) kept.add(line.trim());
            }
            return new ChangedLines(kept);
        } catch (IOException e) {
            throw new IllegalArgumentException("gauntletlines can't read " + file, e);
        }
    }

    @Override
    public InterceptorType type() {
        return InterceptorType.FILTER;
    }

    @Override
    public void begin(ClassTree clazz) {
    }

    @Override
    public Collection<MutationDetails> intercept(Collection<MutationDetails> mutations, Mutater mutater) {
        List<MutationDetails> kept = new ArrayList<MutationDetails>();
        for (MutationDetails m : mutations) {
            if (lines.contains(keyOf(m))) kept.add(m);
        }
        return kept;
    }

    @Override
    public void end() {
    }

    /** "svc/domain/Money.kt:12" for a mutant of svc.domain.Money$Companion on line 12 of Money.kt. */
    static String keyOf(MutationDetails m) {
        String file = m.getFilename();
        if (file == null || file.isEmpty()) return null;
        String name = m.getClassName().asJavaName();
        int dot = name.lastIndexOf('.');
        String pkg = dot < 0 ? "" : name.substring(0, dot).replace('.', '/') + "/";
        return pkg + file + ":" + m.getLineNumber();
    }
}
