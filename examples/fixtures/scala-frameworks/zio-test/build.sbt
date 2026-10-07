ThisBuild / scalaVersion := "3.10.0"

lazy val root = (project in file("."))
  .settings(
    name := "calc",
    libraryDependencies ++= Seq("dev.zio" %% "zio-test" % "2.1.26" % Test, "dev.zio" %% "zio-test-sbt" % "2.1.26" % Test),
    testFrameworks += new TestFramework("zio.test.sbt.ZTestFramework"),
  )
