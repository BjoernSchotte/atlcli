/* Non-blocking advisory locks for native-lock-probe.ts (compiled by bun:ffi cc). */
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

/* 0 = acquired/released, 1 = held by someone else, negative = -errno. */
static int result(int rc) {
  if (rc == 0) return 0;
  return (errno == EAGAIN || errno == EACCES || errno == EWOULDBLOCK) ? 1 : -errno;
}

int lock_flock(int fd, int exclusive) { return result(flock(fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)); }
int unlock_flock(int fd) { return result(flock(fd, LOCK_UN)); }

/* POSIX record lock over the whole file; what Python's fcntl.lockf uses. */
static int posix(int fd, short type) {
  struct flock lock = {0};
  lock.l_type = type;
  lock.l_whence = SEEK_SET;
  return result(fcntl(fd, F_SETLK, &lock));
}
int lock_posix(int fd, int exclusive) { return posix(fd, exclusive ? F_WRLCK : F_RDLCK); }
int unlock_posix(int fd) { return posix(fd, F_UNLCK); }
