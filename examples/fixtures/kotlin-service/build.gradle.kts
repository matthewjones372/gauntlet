plugins {
    kotlin("jvm") version "2.4.10"
    id("org.jetbrains.kotlinx.kover") version "0.9.11"
    id("dev.detekt") version "2.0.0-alpha.6"
    id("info.solidsoft.pitest") version "1.19.0"
}

repositories { mavenCentral() }

kotlin { jvmToolchain(25) }

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> { useJUnitPlatform() }

pitest {
    junit5PluginVersion.set("1.2.3")
    pitestVersion.set("1.30.0")
    targetClasses.set(listOf("svc.*"))
}
