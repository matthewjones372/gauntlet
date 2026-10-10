plugins {
    kotlin("jvm") version "2.4.10"
    id("org.jetbrains.kotlinx.kover") version "0.9.11"
    id("dev.detekt") version "2.0.0-alpha.6"
    id("info.solidsoft.pitest") version "1.19.0"
}

repositories { mavenCentral() }

kotlin {
    jvmToolchain(25)
    // A new project starts strict: a compiler warning fails the build.
    compilerOptions { allWarningsAsErrors.set(true) }
}

// detekt's recommended rules, with this project's overrides in config/detekt.yml when there are any.
detekt { buildUponDefaultConfig = true }

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testImplementation("io.kotest:kotest-property:6.2.5")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> { useJUnitPlatform() }

pitest {
    junit5PluginVersion.set("1.2.3")
    pitestVersion.set("1.30.0")
    targetClasses.set(listOf("{{package}}.*"))
}
