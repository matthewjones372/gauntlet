package gauntlet;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import javax.management.ObjectName;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;

/**
 * Gauntlet's map of what each test class executes (spec 0013). Registered
 * through the ServiceLoader on a baseline's extra test run, alongside the
 * JaCoCo agent with jmx=true. When a top-level test class finishes it takes
 * everything executed since the previous one finished, resetting the agent,
 * and writes it to {gauntlet.testmap.dir}/{class}.exec: work between classes
 * counts for the next one, which only ever adds files to a class. Two
 * top-level classes running at once can't be told apart, so then it writes
 * an "overlap" file and Gauntlet records no map for the task.
 */
public final class TestMapListener implements TestExecutionListener {
    private final String dir = System.getProperty("gauntlet.testmap.dir");
    private String running;
    private String runningClass;

    @Override
    public synchronized void executionStarted(TestIdentifier id) {
        String name = topLevelClass(id);
        if (dir == null || name == null) return;
        if (running != null) mark("overlap", running + " and " + id.getUniqueId());
        running = id.getUniqueId();
        runningClass = name;
    }

    @Override
    public synchronized void executionFinished(TestIdentifier id, TestExecutionResult result) {
        if (dir == null || !id.getUniqueId().equals(running)) return;
        try {
            byte[] data = (byte[]) ManagementFactory.getPlatformMBeanServer().invoke(
                new ObjectName("org.jacoco:type=Runtime"), "getExecutionData", new Object[] { Boolean.TRUE }, new String[] { "boolean" });
            File out = new File(dir, runningClass + ".exec");
            for (int i = 2; out.exists(); i++) out = new File(dir, runningClass + "." + i + ".exec");
            write(out, data);
        } catch (Exception e) {
            mark("failed", e.toString());
        }
        running = null;
        runningClass = null;
    }

    /** A test class's own container; a nested class (Outer$Inner) runs inside its outer class's. */
    private static String topLevelClass(TestIdentifier id) {
        if (!id.getSource().isPresent()) return null;
        TestSource source = id.getSource().get();
        if (!(source instanceof ClassSource)) return null;
        String name = ((ClassSource) source).getClassName();
        return name.indexOf('$') >= 0 ? null : name;
    }

    private void mark(String name, String why) {
        try {
            write(new File(dir, name), why.getBytes("UTF-8"));
        } catch (IOException ignored) {
            // Nothing else can be done from inside the test run; without the file Gauntlet sees no data for this class.
        }
    }

    private static void write(File file, byte[] data) throws IOException {
        file.getParentFile().mkdirs();
        OutputStream out = new FileOutputStream(file);
        try {
            out.write(data);
        } finally {
            out.close();
        }
    }
}
