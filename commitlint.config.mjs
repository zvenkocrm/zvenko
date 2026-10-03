// Conventional Commits (D9). Описание коммита — по-русски, поэтому регистр не проверяем.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "body-max-line-length": [0],
  },
};
