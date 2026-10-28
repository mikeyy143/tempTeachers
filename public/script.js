
"use strict";

const form = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const submitBtn = document.getElementById("submitBtn");
const statusBox = document.getElementById("status");
const resultsSection = document.getElementById("results");
const examResults = document.getElementById("examResults");
const clearBtn = document.getElementById("clearBtn");

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);

  return element;
}

function addStat(container, label, value) {
  const stat = makeElement("div", "stat");
  stat.append(
    makeElement("span", "", label),
    makeElement("strong", "", value)
  );
  container.appendChild(stat);
}

function addTable(container, headers, rows) {
  const wrapper = makeElement("div", "table-wrap");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  headers.forEach((header) => {
    headerRow.appendChild(makeElement("th", "", header));
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");

    row.forEach((cell) => {
      const td = makeElement("td", cell.className || "", cell.value ?? "");
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);
  container.appendChild(wrapper);
}

function renderExam(exam, index) {
  const card = makeElement("article", "exam-card");
  const title = exam.subject || `Exam ${index + 1}`;

  card.appendChild(makeElement("h3", "", title));

  const metadata = makeElement(
    "div",
    "exam-meta",
    `Candidate: ${exam.name || "N/A"} · Hall ticket: ${
      exam.hallticket || "N/A"
    } · Date: ${exam.date || "N/A"} · Time: ${exam.time || "N/A"}`
  );

  card.appendChild(metadata);

  const stats = makeElement("div", "stats");

  addStat(stats, "Calculated Score", `${exam.score ?? 0} / ${exam.max ?? 0}`);
  addStat(stats, "Server Score", exam.serverScore ?? "N/A");
  addStat(stats, "Correct", exam.correct ?? 0);
  addStat(stats, "Wrong", exam.wrong ?? 0);
  addStat(stats, "Skipped", exam.skipped ?? 0);
  addStat(stats, "Grace / Full Marks", exam.grace ?? 0);

  card.appendChild(stats);

  const sectionDetails = document.createElement("details");
  sectionDetails.appendChild(makeElement("summary", "", "Section-wise Analysis"));

  const sectionRows = (exam.sections || []).map((section) => [
    { value: section.name || "Unspecified" },
    { value: section.correct ?? 0, className: "correct" },
    { value: section.wrong ?? 0, className: "wrong" },
    { value: section.skipped ?? 0, className: "skipped" },
    { value: section.grace ?? 0, className: "grace" },
    { value: section.total ?? 0 }
  ]);

  addTable(
    sectionDetails,
    ["Section", "Correct", "Wrong", "Skipped", "Grace", "Total"],
    sectionRows
  );

  card.appendChild(sectionDetails);

  const questionDetails = document.createElement("details");
  questionDetails.appendChild(
    makeElement("summary", "", "Question-wise Analysis")
  );

  const questionRows = (exam.questions || []).map((question) => [
    { value: question.n ?? "—" },
    { value: question.section || "—" },
    { value: question.marked ?? "—" },
    { value: question.answer || "—" },
    {
      value: question.result || "—",
      className: question.result || ""
    }
  ]);

  addTable(
    questionDetails,
    ["Q. No.", "Section", "Marked Option", "Correct Answer", "Result"],
    questionRows
  );

  card.appendChild(questionDetails);

  return card;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    setStatus("Please enter both your username and password.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Analyzing...";
  resultsSection.hidden = true;
  examResults.replaceChildren();

  setStatus("Signing in and retrieving response sheets. Please wait.");

  try {
    const response = await fetch("/api/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status}).`);
    }

    if (!Array.isArray(data.exams) || data.exams.length === 0) {
      throw new Error("No exam results were returned.");
    }

    const fragment = document.createDocumentFragment();

    data.exams.forEach((exam, index) => {
      fragment.appendChild(renderExam(exam, index));
    });

    examResults.appendChild(fragment);
    resultsSection.hidden = false;

    setStatus(
      `Analysis completed successfully. ${data.exams.length} exam(s) found.`,
      "success"
    );

    // Remove the password from the form after the request completes.
    passwordInput.value = "";

    resultsSection.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    setStatus(error.message || "Unable to retrieve results.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Analyze My Score";
  }
});

clearBtn.addEventListener("click", () => {
  examResults.replaceChildren();
  resultsSection.hidden = true;
  setStatus("");
  usernameInput.focus();
});
