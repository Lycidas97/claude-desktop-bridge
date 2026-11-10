#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: inspector-process-path PID [PID ...]\n");
        return 2;
    }
    for (int i = 1; i < argc; i++) {
        char *end;
        long pid = strtol(argv[i], &end, 10);
        if (*end || pid <= 0 || pid > INT_MAX) {
            fprintf(stderr, "invalid PID: %s\n", argv[i]);
            return 2;
        }
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        int length = proc_pidpath((int)pid, path, sizeof(path));
        const char *error = length > 0 ? "" : strerror(errno);
        printf("%ld%c%s%c%s%c", pid, '\0', length > 0 ? path : "", '\0', error, '\0');
    }
    return 0;
}
