use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

const AUTH_FILE_NAME: &str = "auth.json";
const MAX_AUTH_FILE_BYTES: u64 = 1024 * 1024;
const AUTH_ISOLATION_ERROR: &str = "The local ChatGPT sign-in could not be isolated safely.";

#[derive(Debug)]
pub(super) struct TurnPrivacyHome {
    root: PathBuf,
    isolation_parent: PathBuf,
    home_directory: PathBuf,
    codex_home: PathBuf,
    work_directory: PathBuf,
}

impl TurnPrivacyHome {
    pub(super) fn home_directory(&self) -> &Path {
        &self.home_directory
    }

    pub(super) fn codex_home(&self) -> &Path {
        &self.codex_home
    }

    pub(super) fn work_directory(&self) -> &Path {
        &self.work_directory
    }

    #[cfg(test)]
    fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for TurnPrivacyHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir(&self.isolation_parent);
    }
}

pub(super) fn create_turn_privacy_home(
    source_codex_home: &Path,
) -> Result<TurnPrivacyHome, String> {
    let isolation_parent = std::env::temp_dir().join("papercanvas-codex-turns");
    create_turn_privacy_home_at(source_codex_home, &isolation_parent)
}

fn create_turn_privacy_home_at(
    source_codex_home: &Path,
    isolation_parent: &Path,
) -> Result<TurnPrivacyHome, String> {
    let auth_source = validate_auth_source(source_codex_home)?;
    ensure_private_directory(isolation_parent)?;

    let root = isolation_parent.join(uuid::Uuid::new_v4().to_string());
    create_private_directory(&root)?;
    let home_directory = root.join("home");
    let codex_home = home_directory.join(".codex");
    let work_directory = root.join("work");
    let setup = (|| {
        create_private_directory(&home_directory)?;
        create_private_directory(&codex_home)?;
        create_private_directory(&work_directory)?;
        create_auth_symlink(&auth_source, &codex_home.join(AUTH_FILE_NAME))
    })();
    if let Err(message) = setup {
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir(isolation_parent);
        return Err(message);
    }

    Ok(TurnPrivacyHome {
        root,
        isolation_parent: isolation_parent.to_path_buf(),
        home_directory,
        codex_home,
        work_directory,
    })
}

pub(super) fn validate_auth_source(source_codex_home: &Path) -> Result<PathBuf, String> {
    #[cfg(not(unix))]
    {
        let _ = source_codex_home;
        return Err(AUTH_ISOLATION_ERROR.into());
    }

    #[cfg(unix)]
    {
        if !source_codex_home.is_absolute() {
            return Err(AUTH_ISOLATION_ERROR.into());
        }
        let home_metadata = fs::symlink_metadata(source_codex_home)
            .map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        if home_metadata.file_type().is_symlink()
            || !home_metadata.is_dir()
            || home_metadata.uid() != current_user_id()
            || home_metadata.mode() & 0o022 != 0
        {
            return Err(AUTH_ISOLATION_ERROR.into());
        }

        let auth_source = source_codex_home.join(AUTH_FILE_NAME);
        let auth_metadata =
            fs::symlink_metadata(&auth_source).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        let mode = auth_metadata.mode();
        if auth_metadata.file_type().is_symlink()
            || !auth_metadata.is_file()
            || auth_metadata.uid() != current_user_id()
            || mode & 0o077 != 0
            || mode & 0o400 == 0
            || auth_metadata.nlink() != 1
            || auth_metadata.len() == 0
            || auth_metadata.len() > MAX_AUTH_FILE_BYTES
        {
            return Err(AUTH_ISOLATION_ERROR.into());
        }

        let canonical_home =
            fs::canonicalize(source_codex_home).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        let canonical_auth =
            fs::canonicalize(&auth_source).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        if canonical_auth.parent() != Some(canonical_home.as_path()) {
            return Err(AUTH_ISOLATION_ERROR.into());
        }
        Ok(canonical_auth)
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(_) => return Err(AUTH_ISOLATION_ERROR.into()),
    }
    secure_existing_directory(path)
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
    secure_existing_directory(path)
}

fn secure_existing_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(AUTH_ISOLATION_ERROR.into())
    }

    #[cfg(unix)]
    {
        let metadata = fs::symlink_metadata(path).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != current_user_id()
        {
            return Err(AUTH_ISOLATION_ERROR.into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        let secured = fs::symlink_metadata(path).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        if secured.file_type().is_symlink()
            || !secured.is_dir()
            || secured.uid() != current_user_id()
            || secured.mode() & 0o777 != 0o700
        {
            return Err(AUTH_ISOLATION_ERROR.into());
        }
        Ok(())
    }
}

fn create_auth_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = (source, destination);
        Err(AUTH_ISOLATION_ERROR.into())
    }

    #[cfg(unix)]
    {
        symlink(source, destination).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        let metadata =
            fs::symlink_metadata(destination).map_err(|_| AUTH_ISOLATION_ERROR.to_string())?;
        if !metadata.file_type().is_symlink() {
            return Err(AUTH_ISOLATION_ERROR.into());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn current_user_id() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference memory.
    unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    #[cfg(unix)]
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    use uuid::Uuid;

    use super::{create_turn_privacy_home_at, validate_auth_source};

    fn test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("papercanvas-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("test root is created");
        root
    }

    #[cfg(unix)]
    fn secure_codex_home(root: &std::path::Path) -> PathBuf {
        let codex_home = root.join("source-codex-home");
        fs::create_dir(&codex_home).expect("source CODEX_HOME is created");
        fs::set_permissions(&codex_home, fs::Permissions::from_mode(0o700))
            .expect("source CODEX_HOME is private");
        let auth = codex_home.join("auth.json");
        fs::write(&auth, b"{}").expect("synthetic auth is created");
        fs::set_permissions(&auth, fs::Permissions::from_mode(0o600))
            .expect("synthetic auth is private");
        codex_home
    }

    #[cfg(unix)]
    #[test]
    fn turn_home_contains_only_a_validated_auth_symlink_and_is_private() {
        let root = test_root("privacy-home");
        let source_codex_home = secure_codex_home(&root);
        let isolation_parent = root.join("isolated");

        let privacy = create_turn_privacy_home_at(&source_codex_home, &isolation_parent)
            .expect("secure auth is isolated");

        assert_eq!(fs::metadata(privacy.root()).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(privacy.home_directory()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(privacy.codex_home()).unwrap().mode() & 0o777,
            0o700
        );
        let home_entries = fs::read_dir(privacy.home_directory())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(home_entries, [".codex"]);
        let codex_entries = fs::read_dir(privacy.codex_home())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(codex_entries, ["auth.json"]);
        let bridged_auth = privacy.codex_home().join("auth.json");
        assert!(fs::symlink_metadata(&bridged_auth)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(bridged_auth).unwrap(),
            fs::canonicalize(source_codex_home.join("auth.json")).unwrap()
        );

        let turn_root = privacy.root().to_path_buf();
        drop(privacy);
        assert!(!turn_root.exists(), "turn isolation is removed on drop");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn auth_source_rejects_symlinks_and_permissive_files_without_disclosing_paths() {
        let root = test_root("unsafe-auth");
        let source_codex_home = secure_codex_home(&root);
        let auth = source_codex_home.join("auth.json");
        fs::set_permissions(&auth, fs::Permissions::from_mode(0o644)).unwrap();
        let error = validate_auth_source(&source_codex_home)
            .expect_err("group-readable auth must be rejected");
        assert!(!error.contains(root.to_string_lossy().as_ref()));

        fs::remove_file(&auth).unwrap();
        let target = root.join("redirected-auth.json");
        fs::write(&target, b"{}").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &auth).unwrap();
        let error = validate_auth_source(&source_codex_home)
            .expect_err("symlink auth source must be rejected");
        assert!(!error.contains(root.to_string_lossy().as_ref()));

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn auth_source_rejects_a_mutable_parent_directory() {
        let root = test_root("unsafe-auth-parent");
        let source_codex_home = secure_codex_home(&root);
        fs::set_permissions(&source_codex_home, fs::Permissions::from_mode(0o777)).unwrap();

        assert!(validate_auth_source(&source_codex_home).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
